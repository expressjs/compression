// NOTE: Most of this code was ported from "koa-compress"
// See: https://github.com/koajs/compress

"use strict";
var zlib = require("zlib");

module.exports = Encodings;

/**
 * @const
 * whether current node version has brotli support
 */
var hasBrotliSupport = "createBrotliCompress" in zlib;

function Encodings() {
  this.encodingWeights = [];
}

Encodings.supportedEncodings = {
  gzip: true,
  deflate: true,
  identity: true
};

Encodings.preferredEncodings = ["br", "gzip", "deflate", "identity"];

if (hasBrotliSupport) {
  Encodings.supportedEncodings.br = true;
}

Encodings.reDirective = /^\s*(gzip|compress|deflate|br|identity|\*)\s*(?:;\s*q\s*=\s*(\d(?:\.\d)?))?\s*$/;

Encodings.hasBrotliSupport = hasBrotliSupport;

Encodings.prototype.parseAcceptEncoding = function (acceptEncoding) {
  var acceptEncoding = acceptEncoding || "";

  var encodingWeights = this.encodingWeights,
    reDirective = Encodings.reDirective;
  acceptEncoding.split(",").forEach(function (directive) {
    var match = reDirective.exec(directive);
    if (!match) return; // not a supported encoding above

    var encoding = match[1];

    // weight must be in [0, 1]
    var weight = match[2] && !isNaN(match[2]) ? parseFloat(match[2], 10) : 1;
    weight = Math.max(weight, 0);
    weight = Math.min(weight, 1);

    encodingWeights.push({ encoding: encoding, weight: weight });
  });
};

Encodings.prototype.getPreferredContentEncoding = function () {
  var encodingWeights = this.encodingWeights;

  var acceptedEncodings = encodingWeights
    // sort by weight
    .sort(function (a, b) {
      return b.weight - a.weight;
    })
    // filter by supported encodings
    .filter(function (record) {
      return Encodings.supportedEncodings[record.encoding];
    });

  // group them by weights
  var weightClasses = {};
  var weightList = [];
  acceptedEncodings.forEach(function (record) {
    var weight = record.weight;
    if (!weightClasses.hasOwnProperty(weight)) {
      weightClasses[weight] = [];
      weightList.push(weight);
    }
    weightClasses[weight].push(record.encoding);
  });

  // search by weight, descending
  var weights = weightList.sort(function (a, b) {
    return b - a;
  });

  for (var i = 0; i < weights.length; i++) {
    // encodings at this weight
    var encodings = weightClasses[weights[i]];

    // return the first encoding in the preferred list
    for (var j = 0; j < Encodings.preferredEncodings.length; j++) {
      var preferredEncoding = Encodings.preferredEncodings[j];
      if (encodings.indexOf(preferredEncoding) >= 0) return preferredEncoding;
    }
  }

  // no encoding matches, check to see if the client set identity, q=0
  if (encodingWeights["identity"] && encodingWeights["identity"].weight === 0) {
    throw new Error("Please accept br, gzip, deflate, or identity.");
  }

  // by default, return nothing
  return "identity";
};
