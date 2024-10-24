var zlib = require('zlib')
var Negotiator = require('negotiator')

/**
 * @const
 * whether current node version has brotli support
 */
var hasBrotliSupport = 'createBrotliCompress' in zlib

function negotiateEncoding (req, encodings) {
  var negotiator = new Negotiator(req)

  return negotiator.encodings(encodings, hasBrotliSupport ? ['br'] : ['gzip'])[0]
}

module.exports.hasBrotliSupport = hasBrotliSupport
module.exports.negotiateEncoding = negotiateEncoding
