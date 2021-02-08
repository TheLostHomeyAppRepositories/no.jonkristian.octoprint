'use strict';

const Homey = require('homey');

class OctoPrint extends Homey.App {
  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Octoprint has been initialized.');
  }
}

module.exports = OctoPrint;