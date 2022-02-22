'use strict';

const Homey = require('homey');

class OctoPrint extends Homey.App {
  async onInit() {
    this.log('Octoprint has been initialized.');
  }
}

module.exports = OctoPrint;
