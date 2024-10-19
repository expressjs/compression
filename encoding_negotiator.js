var zlib = require('zlib')
var Negotiator = require('negotiator')

/**
 * @const
 * whether current node version has brotli support
 */
var hasBrotliSupport = 'createBrotliCompress' in zlib

function negotiateEncoding (req, encodings_) {
  var negotiator = new Negotiator(req)
  var encodings = encodings_

  // support flattened arguments
  if (encodings && !Array.isArray(encodings)) {
    encodings = new Array(arguments.length)
    for (var i = 0; i < encodings.length; i++) {
      encodings[i] = arguments[i]
    }
  }

  // no encodings, return all requested encodings
  if (!encodings || encodings.length === 0) {
    return negotiator.encodings()
  }

  return negotiator.encodings(encodings, hasBrotliSupport ? ['br'] : ['gzip'])[0] || false
}

module.exports.hasBrotliSupport = hasBrotliSupport
module.exports.negotiateEncoding = negotiateEncoding
