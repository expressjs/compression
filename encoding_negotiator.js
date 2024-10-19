var zlib = require('zlib')

/**
 * @const
 * whether current node version has brotli support
 */
var hasBrotliSupport = 'createBrotliCompress' in zlib

var supportedEncodings = hasBrotliSupport
  ? ['br', 'gzip', 'deflate', 'identity']
  : ['gzip', 'deflate', 'identity']

var preferredEncodings = hasBrotliSupport
  ? ['br', 'gzip']
  : ['gzip']

function negotiateEncoding (header) {
  header = header || ''

  var insts = header.split(',')
  var decoded = []

  for (var i = 0; i < insts.length; i++) {
    var inst = insts[i].match(/^\s*?([^\s;]+?)\s*?(?:;(.*))?$/)
    if (!inst) continue

    var encoding = inst[1]
    if (supportedEncodings.indexOf(encoding) === -1) {
      continue
    }

    var q = 1
    if (inst[2]) {
      var params = inst[2].split(';')
      for (var j = 0; j < params.length; j++) {
        var p = params[j].trim().split('=')
        if (p[0] === 'q') {
          q = parseFloat(p[1])
          break
        }
      }
    }

    if (q < 0 || q > 1) { // invalid
      continue
    }

    decoded.push({ encoding: encoding, q: q, i: i })
  }

  decoded.sort(function (a, b) {
    if (a.q !== b.q) {
      return b.q - a.q // higher quality first
    }

    var aPreferred = preferredEncodings.indexOf(a.encoding)
    var bPreferred = preferredEncodings.indexOf(b.encoding)

    if (aPreferred === -1 && bPreferred === -1) {
      return a.i - b.i // consider the original order
    }

    if (aPreferred !== -1 && bPreferred !== -1) {
      return aPreferred - bPreferred // consider the preferred order
    }

    return aPreferred === -1 ? 1 : -1 // preferred first
  })

  if (decoded.length > 0) {
    return decoded[0].encoding
  }

  return null
}

module.exports.hasBrotliSupport = hasBrotliSupport
module.exports.negotiateEncoding = negotiateEncoding
