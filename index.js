/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

'use strict'

/**
 * Module dependencies.
 * @private
 */

var accepts = require('accepts')
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
var Duplex = require('stream').Duplex
var iltorb = require('iltorb')
var lruCache = require('lru-cache')
var multipipe = require('multipipe')
var onHeaders = require('on-headers')
var Readable = require('stream').Readable
var streamBuffers = require('stream-buffers');
var vary = require('vary')
var Writable = require('stream').Writable
var zlib = require('zlib')
var zopfli = require('node-zopfli')

/**
 * Module exports.
 */

module.exports = compression
module.exports.filter = shouldCompress

/**
 * Module variables.
 * @private
 */

var cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/
// according to https://blogs.akamai.com/2016/02/understanding-brotlis-potential.html , brotli:4
// is slightly faster than gzip with somewhat better compression; good default if we don't want to
// worry about compression runtime being slower than gzip
var BROTLI_DEFAULT_QUALITY = 4

/**
 * Compress response data with gzip / deflate.
 *
 * @param {Object} options
 * @return {Function} middleware
 * @public
 */

function compression(options) {
  var opts = options || {}

  // options
  var filter = opts.filter || shouldCompress
  var threshold = bytes.parse(opts.threshold)

  if (threshold == null) {
    threshold = 1024
  }

  var brotliOpts = opts.brotli || {}
  brotliOpts.quality = brotliOpts.quality || BROTLI_DEFAULT_QUALITY

  var zlibOpts = opts.zlib || {}
  var zlibOptNames = ['flush', 'chunkSize', 'windowBits', 'level', 'memLevel', 'strategy', 'dictionary']
  zlibOptNames.forEach(function (option) {
      zlibOpts[option] = zlibOpts[option] || opts[option];
    })

  if (!opts.hasOwnProperty('cacheSize')) opts.cacheSize = '128mB'
  var cache = opts.cacheSize ? createCache(bytes(opts.cacheSize.toString())) : null;

  var shouldCache = opts.cache || function () { return true; }

  var dummyBrotliFlush = function () { }

  return function compression(req, res, next){
    var ended = false
    var length
    var listeners = []
    var write = res.write
    var on = res.on
    var end = res.end
    var stream

    // flush
    res.flush = function flush() {
      if (stream) {
        stream.flush()
      }
    }

    // proxy

    res.write = function(chunk, encoding){
      if (ended) {
        return false
      }

      if (!this._header) {
        this._implicitHeader()
      }

      return stream
        ? stream.write(new Buffer(chunk, encoding))
        : write.call(this, chunk, encoding)
    };

    res.end = function(chunk, encoding){
      if (ended) {
        return false
      }

      if (!this._header) {
        // estimate the length
        if (!this.getHeader('Content-Length')) {
          length = chunkLength(chunk, encoding)
        }

        this._implicitHeader()
      }

      if (!stream) {
        return end.call(this, chunk, encoding)
      }

      // mark ended
      ended = true

      // write Buffer for Node.js 0.8
      return chunk
        ? stream.end(new Buffer(chunk, encoding))
        : stream.end()
    };

    res.on = function(type, listener){
      if (!listeners || type !== 'drain') {
        return on.call(this, type, listener)
      }

      if (stream) {
        return stream.on(type, listener)
      }

      // buffer listeners for future stream
      listeners.push([type, listener])

      return this
    }

    function nocompress(msg) {
      debug('no compression: %s', msg)
      addListeners(res, on, listeners)
      listeners = null
    }

    onHeaders(res, function(){
      // determine if request is filtered
      if (!filter(req, res)) {
        nocompress('filtered')
        return
      }

      // determine if the entity should be transformed
      if (!shouldTransform(req, res)) {
        nocompress('no transform')
        return
      }

      // vary
      vary(res, 'Accept-Encoding')

      // content-length below threshold
      if (Number(res.getHeader('Content-Length')) < threshold || length < threshold) {
        nocompress('size below threshold')
        return
      }

      var encoding = res.getHeader('Content-Encoding') || 'identity';

      // already encoded
      if ('identity' !== encoding) {
        nocompress('already encoded')
        return
      }

      // head
      if ('HEAD' === req.method) {
        nocompress('HEAD request')
        return
      }

      var contentType = res.getHeader('Content-Type');

      // compression method
      var accept = accepts(req)
      // send in each compression method separately to ignore client preference and
      // instead enforce server preference. also, server-sent events (mime type of
      // text/event-stream) require flush functionality, so skip brotli in that
      // case.
      var method = (contentType !== "text/event-stream" && accept.encoding('br'))
        || accept.encoding('gzip')
        || accept.encoding('deflate')
        || accept.encoding('identity');

      // negotiation failed
      if (!method || method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // do we have this coding/url/etag combo in the cache?
      var etag = res.getHeader('ETag') || null;
      var cacheable = cache && shouldCache(req, res) && etag && res.statusCode >= 200 && res.statusCode < 300
      if (cacheable) {
        var buffer = cache.lookup(method, req.url, etag)
        if (buffer) {
          // the rest of the code expects a duplex stream, so
          // make a duplex stream that just ignores its input
          stream = duplexFromBuffer(buffer)
        }
      }

      // if stream is not assigned, we got a cache miss and need to compress
      // the result
      if (!stream) {
        // compression stream
        debug('%s compression', method)
        switch (method) {
          case 'br':
            stream = iltorb.compressStream(brotliOpts)
            // brotli has no flush method. add a dummy flush method here.
            stream.flush = dummyBrotliFlush;
            break
          case 'gzip':
            stream = zlib.createGzip(zlibOpts)
            break
          case 'deflate':
            stream = zlib.createDeflate(zlibOpts)
            break
        }

        // if it is cacheable, let's keep hold of the compressed chunks and cache
        // them once the compression stream ends.
        if (cacheable) {
          var chunks = [];
          stream.on('data', function (chunk){
            chunks.push(chunk)
          })
          stream.on('end', function () {
            cache.add(method, req.url, etag, chunks)
          })
        }
      }

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners)

      // header fields
      res.setHeader('Content-Encoding', method);
      res.removeHeader('Content-Length');

      // compression
      stream.on('data', function(chunk){
        if (write.call(res, chunk) === false) {
          stream.pause()
        }
      });

      stream.on('end', function(){
        end.call(res);
      });

      on.call(res, 'drain', function() {
        stream.resume()
      });
    });

    next();
  };
}

/**
 * Add bufferred listeners to stream
 * @private
 */

function addListeners(stream, on, listeners) {
  for (var i = 0; i < listeners.length; i++) {
    on.apply(stream, listeners[i])
  }
}

/**
 * Get the length of a given chunk
 */

function chunkLength(chunk, encoding) {
  if (!chunk) {
    return 0
  }

  return !Buffer.isBuffer(chunk)
    ? Buffer.byteLength(chunk, encoding)
    : chunk.length
}

/**
 * Default filter function.
 * @private
 */

function shouldCompress(req, res) {
  var type = res.getHeader('Content-Type')

  if (type === undefined || !compressible(type)) {
    debug('%s not compressible', type)
    return false
  }

  return true
}

/**
 * Determine if the entity should be transformed.
 * @private
 */

function shouldTransform(req, res) {
  var cacheControl = res.getHeader('Cache-Control')

  // Don't compress for Cache-Control: no-transform
  // https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl
    || !cacheControlNoTransformRegExp.test(cacheControl)
}

function createCache(size) {
  var index = {}
  var lru = lruCache({
    max: size,
    length: function (item, key) { return item.buffer.length + item.coding.length + 2 * (item.url.length + item.etag.length) },
    dispose: function (key, item) {
      // remove this particular representation (by etag)
      delete index[item.coding][item.url][item.etag]

      // if there are no more representations of the url left, remove the
      // entry for the url.
      if (Object.keys(index[item.coding][item.url]).length === 0) {
        delete index[item.coding][item.url]
      }
    }
  })

  return {
    add: function (coding, url, etag, buffer) {
      // check to see if another request already filled the cache; avoids
      // a lot of work if there's a thundering herd.
      if (index[coding] && index[coding][url] && index[coding][url][etag]) {
        return
      }

      if (Array.isArray(buffer)) {
        buffer = Buffer.concat(buffer)
      }

      var item = {
        coding: coding,
        url: url,
        etag: etag,
        buffer: buffer
      }
      var key = {}

      index[coding] = index[coding] || {}
      index[coding][url] = index[coding][url] || {}
      index[coding][url][etag] = key

      lru.set(key, item)

      // now asynchronously re-encode the entry at best quality
      var result = writableToBuffer()

      readableFromBuffer(buffer)
        .pipe(getBestQualityReencoder(coding))
        .pipe(result)
        .on('finish', function () {
          var itemInCache = lru.peek(key)
          if (itemInCache) {
            itemInCache.buffer = result.toBuffer()
          }
        })
    },

    lookup: function (coding, url, etag) {
      if (index[coding] && index[coding][url] && index[coding][url][etag]) {
        return lru.get(index[coding][url][etag]).buffer
      }
      return null
    }
  }
}

function readableFromBuffer(buffer) {
  return new Readable({
    read: function (size) {
      if (!this.ended) {
        this.push(buffer)
        this.ended = true
      } else {
        this.push(null)
      }
    }
  })
}

function writableToBuffer() {
  var chunks = []
  var result = new Writable({
    write: function (chunk, encoding, callback) {
      chunks.push(chunk)
      callback()
    }
  })
  result.toBuffer = function () {
    return Buffer.concat(chunks)
  }
  return result
}

// this duplex just ignores its write side and reads out the buffer as
// requested
function duplexFromBuffer(buffer) {
  return new Duplex({
    read: function(size) {
      if (!this.cursor) this.cursor = 0;
      if (this.cursor >= buffer.length) {
        this.push(null)
        return
      }

      var endIndex = Math.min(this.cursor + size, buffer.length)
      this.push(buffer.slice(this.cursor, endIndex))
      this.cursor = endIndex
    },

    write: function(chunk, encoding, callback) {
      callback()
    }
  })
}

// get a decode --> encode transform stream that will re-encode the content at
// the best quality available for that coding method.
function getBestQualityReencoder(coding) {
  switch (coding) {
    case 'gzip':
      return multipipe(zlib.createGunzip(), zopfli.createGzip())
    case 'deflate':
      return multipipe(zlib.createInflate(), zopfli.createDeflate())
    case 'br':
      return multipipe(iltorb.decompressStream(), iltorb.compressStream())
  }
}
