/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014 Jonathan Ong
 * Copyright(c) 2014 Douglas Christopher Wilson
 * MIT Licensed
 */

/**
 * Module dependencies.
 * @private
 */

var accepts = require('accepts')
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
var onHeaders = require('on-headers')
var vary = require('vary')
var zlib = require('zlib')

/**
 * Module exports.
 */

module.exports = compression
module.exports.filter = shouldCompress

/**
 * Compress response data with gzip / deflate.
 *
 * @param {Object} options
 * @return {Function} middleware
 * @public
 */

function compression(options) {
  var opts = options || {}

  var filter = opts.filter || shouldCompress
  var threshold = typeof opts.threshold === 'string'
    ? bytes(opts.threshold)
    : opts.threshold

  if (threshold == null) {
    threshold = 1024
  }

  return function compression(req, res, next){
    var compress = true
    var listeners = []
    var write = res.write
    var on = res.on
    var end = res.end
    var stream

    // see #8
    req.on('close', function(){
      res.write = res.end = noop
    });

    // flush is noop by default
    res.flush = noop;

    // proxy

    res.write = function(chunk, encoding){
      if (!this._header) {
        // if content-length is set and is lower
        // than the threshold, don't compress
        var len = Number(res.getHeader('Content-Length'))
        checkthreshold(len)
        this._implicitHeader();
      }
      return stream
        ? stream.write(new Buffer(chunk, encoding))
        : write.call(res, chunk, encoding);
    };

    res.end = function(chunk, encoding){
      var len

      if (chunk) {
        len = Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk, encoding)
      }

      if (!this._header) {
        len = Number(this.getHeader('Content-Length')) || len
        checkthreshold(len)
        this._implicitHeader()
      }

      return stream
        ? stream.end(chunk, encoding)
        : end.call(res, chunk, encoding)
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

    function checkthreshold(len) {
      if (compress && len < threshold) {
        debug('size below threshold')
        compress = false
      }
    }

    function nocompress(msg) {
      debug('no compression' + (msg ? ': ' + msg : ''))
      addListeners(res, on, listeners)
      listeners = null
    }

    onHeaders(res, function(){
      // determine if request is filtered
      if (!filter(req, res)) {
        nocompress('filtered')
        return
      }

      // vary
      vary(res, 'Accept-Encoding')

      if (!compress) {
        nocompress()
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

      // compression method
      var accept = accepts(req)
      var method = accept.encoding(['gzip', 'deflate', 'identity'])

      // negotiation failed
      if (!method || method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // compression stream
      debug('%s compression', method)
      stream = method === 'gzip'
        ? zlib.createGzip(opts)
        : zlib.createDeflate(opts)

      // add bufferred listeners to stream
      addListeners(stream, stream.on, listeners)

      // overwrite the flush method
      res.flush = function(){
        stream.flush();
      }

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
 * No-operation function
 * @private
 */

function noop(){}

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
