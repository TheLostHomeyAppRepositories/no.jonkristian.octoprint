'use strict';

const Homey = require('homey');

class OctoPrint extends Homey.App {
  async onInit() {
    this.log('OctoPrint has been initialized.');
  }

  getOctoPrintDeviceData() {
    // Get devices of driver 'octoprint'
    const devices = this.homey.drivers.getDriver('octoprint').getDevices();

    if (devices.length > 0) {
      const device = devices[0];

      // Get capabilities values
      const state = device.getCapabilityValue('printer_state') || 'Unknown';
      const completion = device.getCapabilityValue('measure_completion') || 0;
      const timeLeft = device.getCapabilityValue('job_left') || 'N/A';
      const bedTemp = device.getCapabilityValue('measure_temperature.bed') || 'N/A';
      const hotendTemp = device.getCapabilityValue('measure_temperature.tool') || 'N/A';

      return {
        name: device.getName(),
        state,
        completion,
        timeLeft,
        bedTemp,
        hotendTemp,
      };
    } else {
      return null;
    }
  }
}

module.exports = OctoPrint;
