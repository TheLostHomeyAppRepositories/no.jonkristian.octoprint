'use strict';

module.exports = {
  async getDeviceData({ homey }) {
    try {
      const deviceData = homey.app.getOctoPrintDeviceData();

      if (!deviceData) {
        throw new Error('No OctoPrint device found.');
      }

      return deviceData;
    } catch (error) {
      console.error('Error fetching device data:', error);
      throw error;
    }
  },
};
