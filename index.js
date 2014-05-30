/*!
 * compression
 * Copyright(c) 2010 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var zlib = require('zlib');
var accepts = require('accepts');
var bytes = require('bytes');
var onHeaders = require('on-headers');
var compressible = require('compressible');

/**
 * Supported content-encoding methods.
 */

exports.methods = {
    gzip: zlib.createGzip
  , deflate: zlib.createDeflate
};

/**
 * Default filter function.
 */

exports.filter = function(req, res){
  return compressible(res.getHeader('Content-Type'));
};

/**
 * Compress response data with gzip / deflate.
 *
 * See README.md for documentation of options.
 *
 * @param {Object} options
 * @return {Function} middleware
 * @api public
 */

module.exports = function compression(options) {
  options = options || {};
  var filter = options.filter || exports.filter;
  var threshold;

  if (false === options.threshold || 0 === options.threshold) {
    threshold = 0
  } else if ('string' === typeof options.threshold) {
    threshold = bytes(options.threshold)
  } else {
    threshold = options.threshold || 1024
  }

  return function compression(req, res, next){
    var write = res.write
      , end = res.end
      , compress = true
      , stream;

    // see #8
    req.on('close', function(){
      res.write = res.end = function(){};
    });

    // flush is noop by default
    res.flush = noop;

    // proxy

    res.write = function(chunk, encoding){
      if (!this._header) {
        // if content-length is set and is lower
        // than the threshold, don't compress
        var length = res.getHeader('content-length');
        if (!isNaN(length) && length < threshold) compress = false;
        this._implicitHeader();
      }
      return stream
        ? stream.write(new Buffer(chunk, encoding))
        : write.call(res, chunk, encoding);
    };

    res.end = function(chunk, encoding){
      if (chunk) {
        if (!this._header && getSize(chunk) < threshold) compress = false;
        this.write(chunk, encoding);
      } else if (!this._header) {
        // response size === 0
        compress = false;
      }
      return stream
        ? stream.end()
        : end.call(res);
    };

    onHeaders(res, function(){
      // default request filter
      if (!filter(req, res)) return;

      // vary
      var vary = res.getHeader('Vary');
      if (!vary) {
        res.setHeader('Vary', 'Accept-Encoding');
      } else if (!~vary.indexOf('Accept-Encoding')) {
        res.setHeader('Vary', vary + ', Accept-Encoding');
      }

      if (!compress) return;

      var encoding = res.getHeader('Content-Encoding') || 'identity';

      // already encoded
      if ('identity' != encoding) return;

      // head
      if ('HEAD' == req.method) return;

      // compression method
      var accept = accepts(req);
      var method = accept.encodings(['gzip', 'deflate', 'identity']);

      // negotiation failed
      if (!method || method === 'identity') return;

      // compression stream
      stream = exports.methods[method](options);

      // overwrite the flush method
      res.flush = function(){
        stream.flush();
      }

      // header fields
      res.setHeader('Content-Encoding', method);
      res.removeHeader('Content-Length');

      // compression
      stream.on('data', function(chunk){
        write.call(res, chunk);
      });

      stream.on('end', function(){
        end.call(res);
      });

      stream.on('drain', function() {
        res.emit('drain');
      });
    });

    next();
  };
};

function getSize(chunk) {
  return Buffer.isBuffer(chunk)
    ? chunk.length
    : Buffer.byteLength(chunk);
}

function noop(){}
