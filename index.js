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

var { finished } = require('node:stream')
var Negotiator = require('negotiator')
var bytes = require('bytes')
var compressible = require('compressible')
var debug = require('debug')('compression')
const isFinished = require('on-finished').isFinished
var onHeaders = require('on-headers')
var vary = require('vary')
var zlib = require('zlib')

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
var ENCODING_OPTIONS = ['br', 'gzip', 'deflate']
var PREFERRED_ENCODING = ['br', 'gzip']

/**
 * Compress response data with gzip / deflate.
 *
 * @param {Object} [options]
 * @return {Function} middleware
 * @public
 */

function compression (options) {
  const opts = options || {}
  const encodingOpts = opts?.encodings
  const encodingSupported = ENCODING_OPTIONS.filter(enc => encodingOpts?.[enc] !== false)
  const optsBrotli = {
    ...encodingOpts?.br,
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // set the default level to a reasonable value with balanced speed/ratio
      ...encodingOpts?.br?.params
    }
  }

  // options
  var filter = opts.filter || shouldCompress
  var threshold = bytes.parse(opts.threshold)
  var enforceEncoding = opts.enforceEncoding || 'identity'

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
    res.flush = function flush (cb) {
      if (stream) {
        stream.flush(cb)
      }
    }

    // proxy

    res.write = function write (chunk, encoding) {
      if (ended) {
        return false
      }

      if (!res.headersSent) {
        this.writeHead(this.statusCode)
      }

      return stream
        ? stream.write(toBuffer(chunk, encoding))
        : _write.call(this, chunk, encoding)
    }

    res.end = function end (chunk, encoding) {
      if (ended) {
        return false
      }

      if (!res.headersSent) {
        // estimate the length
        if (!this.getHeader('Content-Length')) {
          length = chunkLength(chunk, encoding)
        }

        this.writeHead(this.statusCode)
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

      // compression method
      var negotiator = new Negotiator(req)
      var method = negotiator.encoding(encodingSupported, PREFERRED_ENCODING)

      // if no method is found, use the default encoding
      if (!req.headers['accept-encoding'] && encodingSupported.includes(enforceEncoding)) {
        method = enforceEncoding
      }

      // negotiation failed
      if (!method || method === 'identity') {
        nocompress('not acceptable')
        return
      }

      // compression stream
      debug('%s compression', method)
      if (method === 'gzip') {
        stream = zlib.createGzip(encodingOpts?.gzip)
      } else if (method === 'br') {
        stream = zlib.createBrotliCompress(optsBrotli)
      } else if (method === 'deflate') {
        stream = zlib.createDeflate(encodingOpts?.deflate)
      }

      // add buffered listeners to stream
      addListeners(stream, stream.on, listeners)

      // header fields
      res.setHeader('Content-Encoding', method)
      res.removeHeader('Content-Length')

      // compression
      stream.on('data', function onStreamData (chunk) {
        if (isFinished(res)) {
          debug('response finished')
          return
        }
        if (_write.call(res, chunk) === false) {
          debug('pausing compression stream')
          stream.pause()
        }
      })

      stream.on('end', function onStreamEnd () {
        _end.call(res)
      })

      _on.call(res, 'drain', function onResponseDrain () {
        stream.resume()
      })

      // In case the stream is paused when the response finishes (e.g.  because
      // the client cuts the connection), its `drain` event may not get emitted.
      // The following handler is here to ensure that the stream gets resumed so
      // it ends up emitting its `end` event and calling the original
      // `res.end()`.
      finished(res, function onResponseFinished () {
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

  return Buffer.isBuffer(chunk)
    ? chunk.length
    : Buffer.byteLength(chunk, encoding)
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
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, encoding)
}
