'use strict';

module.exports = {

  async getDeviceData({ homey, query }) {
    try {
      // homey.app.log('🔍 getDeviceData endpoint was called with query:', query);

      const { deviceId } = query;
      if (!deviceId) {
        throw new Error('No deviceId in query');
      }

      const deviceData = homey.app.getOctoPrintDeviceDataById(deviceId);
      // homey.app.log('🔍 getDeviceData returning:', deviceData);

      if (!deviceData) {
        throw new Error(`No data for deviceId=${deviceId}`);
      }
      return deviceData;
    } catch (error) {
      console.error('Error fetching device data:', error);
      throw error;
    }
  },

};
