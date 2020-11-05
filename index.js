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
var Buffer = require('safe-buffer').Buffer
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
var onHeaders = require('on-headers')
var vary = require('vary')
var zlib = require('zlib')
var objectAssign = require('object-assign')

/**
 * Module exports.
 */

module.exports = compression
module.exports.filter = shouldCompress

/**
 * @const
 * whether current node version has brotli support
 */
var hasBrotliSupport = 'createBrotliCompress' in zlib

var preferredEncodings = ['gzip', 'deflate', 'identity']
if (hasBrotliSupport) {
  preferredEncodings.unshift('br')
}

/**
 * Module variables.
 * @private
 */

var cacheControlNoTransformRegExp = /(?:^|,)\s*?no-transform\s*?(?:,|$)/

/**
 * Compress response data with gzip / deflate.
 *
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */

function compression (options) {
  var opts = options || {}

  if (hasBrotliSupport) {
    // set the default level to a reasonable value with balanced speed/ratio
    if (opts.params === undefined) {
      opts.params = {}
    }

    if (opts.params[zlib.constants.BROTLI_PARAM_QUALITY] === undefined) {
      opts.params[zlib.constants.BROTLI_PARAM_QUALITY] = 4
    }
  }

  // options
  var filter = opts.filter || shouldCompress
  var threshold = bytes.parse(opts.threshold)

  if (threshold == null) {
    threshold = 1024
  }

  return function compression (req, res, next) {
    var ended = false
    var length
    var listeners = []
    var stream

    var _end = res.end
    var _on = res.on
    var _write = res.write

    // flush
    res.flush = function flush () {
      if (stream) {
        stream.flush()
      }
    }

    // proxy

    res.write = function write (chunk, encoding) {
      if (ended) {
        return false
      }

      if (!this._header) {
        this._implicitHeader()
      }

      return stream
        ? stream.write(toBuffer(chunk, encoding))
        : _write.call(this, chunk, encoding)
    }

    res.end = function end (chunk, encoding) {
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
        return _end.call(this, chunk, encoding)
      }

      // mark ended
      ended = true

      // write Buffer for Node.js 0.8
      return chunk
        ? stream.end(toBuffer(chunk, encoding))
        : stream.end()
    }

    res.on = function on (type, listener) {
      if (!listeners || type !== 'drain') {
        return _on.call(this, type, listener)
      }

      if (stream) {
        return stream.on(type, listener)
      }

      // buffer listeners for future stream
      listeners.push([type, listener])

      return this
    }

    function nocompress (msg) {
      debug('no compression: %s', msg)
      addListeners(res, _on, listeners)
      listeners = null
    }

    onHeaders(res, function onResponseHeaders () {
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

      var encoding = res.getHeader('Content-Encoding') || 'identity'

      // already encoded
      if (encoding !== 'identity') {
        nocompress('already encoded')
        return
      }

      // head
      if (req.method === 'HEAD') {
        nocompress('HEAD request')
        return
      }

      // force proper priorization
      var headers = objectAssign({}, req.headers, options.prioritizeClient ? null : { 'accept-encoding': prioritize(req.headers['accept-encoding']) })

      // the accepts function takes in a request object but only reads the headers
      // So, to save a bit of memory, we send an object with only the headers propery
      // this way we don't have to clone the entire request
      var accept = accepts({ headers: headers })
      // compression method
      var method = accept.encoding(preferredEncodings)

      // negotiation failed
      if (!method || method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // compression stream
      debug('%s compression', method)
      stream = method === 'gzip'
        ? zlib.createGzip(opts)
        : method === 'br'
          ? zlib.createBrotliCompress(opts)
          : zlib.createDeflate(opts)

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners)

      // header fields
      res.setHeader('Content-Encoding', method)
      res.removeHeader('Content-Length')

      // compression
      stream.on('data', function onStreamData (chunk) {
        if (_write.call(res, chunk) === false) {
          stream.pause()
        }
      })

      stream.on('end', function onStreamEnd () {
        _end.call(res)
      })

      _on.call(res, 'drain', function onResponseDrain () {
        stream.resume()
      })
    })

    next()
  }
}

/**
 * Add bufferred listeners to stream
 * @private
 */

function addListeners (stream, on, listeners) {
  for (var i = 0; i < listeners.length; i++) {
    on.apply(stream, listeners[i])
  }
}

/**
 * Get the length of a given chunk
 */

function chunkLength (chunk, encoding) {
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

function shouldCompress (req, res) {
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

function shouldTransform (req, res) {
  var cacheControl = res.getHeader('Cache-Control')

  // Don't compress for Cache-Control: no-transform
  // https://tools.ietf.org/html/rfc7234#section-5.2.2.4
  return !cacheControl ||
    !cacheControlNoTransformRegExp.test(cacheControl)
}

/**
 * Coerce arguments to Buffer
 * @private
 */

function toBuffer (chunk, encoding) {
  return !Buffer.isBuffer(chunk)
    ? Buffer.from(chunk, encoding)
    : chunk
}

/**
 * Most browsers send "br" (brotli) as the last value in
 * in the 'Accept-Encoding' header which causes it to be
 * deprioritized according to the spec.
 *
 * This is typically not what end users actually want so here
 * we force the "br" (brotli) value to first in the list so that
 * it will get properly prioritized and used.
 *
 * It's worth noting that although this is not "spec compliant",
 * we belive it follows a well-established convention.
 *
 * @private
 */
function prioritize (str) {
  if(str == undefined) {
    return undefined
  }
  return str
    .split(',')
    .sort(sortEncodings)
    .join(',')
}

/**
 * Sort compression encodings in order of our preference:
 * br > gzip > deflate
 *
 * @private
 */
function sortEncodings (a, b) {
  var al = a.toLowerCase()
  var bl = b.toLowerCase()
  if (al.indexOf('br') >= 0) {
    return -1
  }
  if (al.indexOf('gzip') >= 0) {
    return bl.indexOf('br') >= 0 ? 1 : -1
  }
  // we need these inverse rules to fix a stable sort bug
  // found in node 10.x
  if (bl.indexOf('br') >= 0) {
    return 1
  }
  if (bl.indexOf('gzip') >= 0) {
    return 1
  }
  return 0
}
