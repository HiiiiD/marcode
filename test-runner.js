const Mocha = require('mocha');
const path = require('path');
const fs = require('fs');

const mocha = new Mocha({ ui: 'bdd', reporter: 'spec' });

// Manually add test files
const testDir = path.resolve(__dirname, 'out/test/unit');
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));

files.forEach(file => {
  mocha.addFile(path.join(testDir, file));
});

// Expose mocha globals before running
const mocha_module = require('mocha');
global.suite = mocha_module.describe;
global.test = mocha_module.it;
global.describe = mocha_module.describe;
global.it = mocha_module.it;
global.before = mocha_module.before;
global.beforeEach = mocha_module.beforeEach;
global.after = mocha_module.after;
global.afterEach = mocha_module.afterEach;
global.xit = mocha_module.xit;
global.xdescribe = mocha_module.xdescribe;

mocha.run(failures => {
  process.exitCode = failures ? 1 : 0;
});
