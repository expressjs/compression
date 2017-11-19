const fs         = require('fs');
const {join}     = require('path');
const readmePath = join(__dirname, 'README.md');
const version    = require('./package.json').version;

const replacements = {
  'https://img.shields.io/travis/Alorel/shrink-ray.svg':           `https://img.shields.io/travis/Alorel/shrink-ray/${version}.svg`,
  'https://img.shields.io/coveralls/github/Alorel/shrink-ray.svg': `https://img.shields.io/coveralls/github/Alorel/shrink-ray/${version}.svg`
};

let readme = fs.readFileSync(readmePath, 'utf8');

Object.keys(replacements)
      .map(find => {
        return {
          find:    new RegExp(find, 'i'),
          replace: replacements[find]
        };
      })
      .forEach(r => {
        readme = readme.replace(r.find, r.replace);
      });

fs.writeFileSync(readmePath, readme);
