'use strict';

const Homey = require('homey');

class OctoPrint extends Homey.App {

  async onInit() {
    this.log('OctoPrint has been initialized.');

    // =========================================
    // AUTOCOMPLETE SETUP FOR WIDGET SETTING
    // =========================================
    // Register the widget's autocomplete listener on "selectedDeviceId"
    const widget = this.homey.dashboards.getWidget('octoprint');
    widget.registerSettingAutocompleteListener('selectedDeviceId', async (query, settings) => {
      // this.log('🔎 Autocomplete called with query:', query);

      // 1) Fetch all known OctoPrint devices
      const devices = this.getAllOctoPrintDevices();

      // 2) Filter by user query (case-insensitive)
      const filtered = devices.filter(d =>
        d.name.toLowerCase().includes(query.toLowerCase())
      );

      // 3) Return them in the format { name, id, description, ... }
      return filtered.map(d => ({
        // 'name' is the label shown to the user
        name: d.name,
        // 'id' is what actually gets stored when they pick this device
        id: d.id,
        // Optional extra info
        description: `Device ID: ${d.id}`
      }));
    });
  }

  /**
   * Return basic info (id + name) for all OctoPrint devices,
   * so the widget (autocomplete) can list them when the user types.
   */
  getAllOctoPrintDevices() {
    const driver = this.homey.drivers.getDriver('octoprint');
    if (!driver) {
      this.log('❌ Driver "octoprint" not found');
      return [];
    }
    const devices = driver.getDevices();
    if (!Array.isArray(devices) || devices.length === 0) {
      this.log('❌ No OctoPrint devices paired');
      return [];
    }

    // Return minimal { id, name } objects
    return devices.map(device => ({
      id: device.getData().id,
      name: device.getName(),
    }));
  }

  /**
   * Return data for a specific OctoPrint device by ID
   */
  getOctoPrintDeviceDataById(deviceId) {
    const driver = this.homey.drivers.getDriver('octoprint');
    if (!driver) {
      this.log('❌ Driver "octoprint" not found');
      return null;
    }

    const devices = driver.getDevices();
    if (!Array.isArray(devices) || devices.length === 0) {
      this.log('❌ No devices found in driver');
      return null;
    }

    // Find the device whose getData().id matches
    const device = devices.find(d => d.getData().id === deviceId);
    if (!device) {
      this.log(`❌ No device found with ID "${deviceId}"`);
      return null;
    }

    // Fetch capabilities
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
  }

}

module.exports = OctoPrint;
