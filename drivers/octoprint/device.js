'use strict';

const Homey = require('homey');
const { OctoprintAPI } = require('../../lib/octoprint.js');
const { pipeline } = require('stream/promises');

class OctoprintDevice extends Homey.Device {
	static CAMERA_ID = 'front';
	static STREAM_MODES = {
		webrtc_native: '/webcam/webrtc',
		video_auto: '/webcam/video',
		hls: '/webcam/video.m3u8',
		mp4: '/webcam/video.mp4',
		mkv: '/webcam/video.mkv',
		mjpeg: '/webcam/?action=stream',
		custom: null,
	};

	/**
	 * onInit is called when the device is initialized.
	 */
	async onInit() {
		if (this._pollPromise) await this.onUninit();
		this._stopped = false;
		this._timers = new Set();
		// Migrate to all new capabilities
		this.log('OctoprintDriver initialization started');
		await this.ensureCameraSettings();
		
		if (this.getSetting('heated_bed') === false) {
			if (this.hasCapability('target_temperature.bed')) {
				await this.removeCapability('target_temperature.bed').catch(this.error);
			}
			if (this.hasCapability('measure_temperature.bed')) {
				await this.removeCapability('measure_temperature.bed').catch(this.error);
			}
		}
		else {
			if (!this.hasCapability('target_temperature.bed')) {
				await this.addCapability('target_temperature.bed').catch(this.error);
			}
			if (!this.hasCapability('measure_temperature.bed')) {
				await this.addCapability('measure_temperature.bed').catch(this.error);
			}
		}

		if (!this.hasCapability('target_temperature.tool')) {
			await this.addCapability('target_temperature.tool').catch(this.error);
		}
		if (!this.hasCapability('measure_temperature.tool')) {
			await this.addCapability('measure_temperature.tool').catch(this.error);
		}

		if (this.getSetting('heated_chamber') === true) {
			if (!this.hasCapability('target_temperature.chamber')) {
				await this.addCapability('target_temperature.chamber').catch(this.error);
			}
			if (!this.hasCapability('measure_temperature.chamber')) {
				await this.addCapability('measure_temperature.chamber').catch(this.error);
			}
		}
		else if (this.getSetting('measured_chamber') === true) {
			if (this.hasCapability('target_temperature.chamber')) {
				await this.removeCapability('target_temperature.chamber').catch(this.error);
			}
			if (!this.hasCapability('measure_temperature.chamber')) {
				await this.addCapability('measure_temperature.chamber').catch(this.error);
			}
		}
		else {
			if (this.hasCapability('target_temperature.chamber')) {
				await this.removeCapability('target_temperature.chamber').catch(this.error);
			}
			if (this.hasCapability('measure_temperature.chamber')) {
				await this.removeCapability('measure_temperature.chamber').catch(this.error);
			}
		}

		if (!this.hasCapability('job_end_time')) {
			await this.addCapability('job_end_time').catch(this.error);
		}
		if (!this.hasCapability('measure_completion')) {
			await this.addCapability('measure_completion').catch(this.error);
		}
		if (!this.hasCapability('job_file')) {
			await this.addCapability('job_file').catch(this.error);
		}
		if (!this.hasCapability('emergency_stop_m112')) {
			await this.addCapability('emergency_stop_m112').catch(this.error);
		}
		if (!this.hasCapability('button.restart_octoprint')) {
			await this.addCapability('button.restart_octoprint').catch(this.error);
		}
		if (!this.hasCapability('button.reboot_raspberry')) {
			await this.addCapability('button.reboot_raspberry').catch(this.error);
		}
		if (!this.hasCapability('button.shutdown_raspberry')) {
			await this.addCapability('button.shutdown_raspberry').catch(this.error);
		}

		// During boot make sure the cancel and emergency stop capabilities are false
		await this.setCapabilityValue('job_cancel', false).catch(this.error);
		await this.setCapabilityValue('emergency_stop_m112', false).catch(this.error);

		this.octoprint = new OctoprintAPI({
			address: this.getSetting('address'),
			apikey: this.getSetting('apikey')
		});

		// Query the current state of the printer
		try {
			const currentState = await this.octoprint.getPrinterState();

			// Set capability values based on the current state
			if (currentState === 'Printing') {
				await this.setCapabilityValue('job_pause', false);
				await this.setCapabilityValue('job_resume', false);
			} else if (currentState === 'Paused') {
				await this.setCapabilityValue('job_pause', false);
				await this.setCapabilityValue('job_resume', true);
			} else if (currentState === 'Operational') {
				// When printer is Operational, both pause and resume should be false
				await this.setCapabilityValue('job_pause', false);
				await this.setCapabilityValue('job_resume', false);
			} else {
				// For any other state, also set both to false
				await this.setCapabilityValue('job_pause', false);
				await this.setCapabilityValue('job_resume', false);
			}
		} catch (error) {
			this.error('Error fetching printer state:', error);
			await this.setUnavailable('Unable to fetch printer state');
		}

		// Prepopulate the printer object
		this.printer = {
			server: null,
			state: null,
			snapshot: this.getSetting('snapshot_active'),
			stream: this.isStreamActive(),
			stream_config: this.getStreamConfigSignature(),
			temp: {
				bed: {
					actual: '-',
					target: '-'
				},
				tool0: {
					actual: '-',
					target: '-'
				},
				chamber: {
					actual: '-',
					target: '-'
				}
			},
			job: {
				file: '-',
				completion: 0,
				completion_time_calculated: 0,
				estimate: '-',
				estimate_hms: '-',
				estimate_seconds: '-',
				estimate_end_time: '-',
				estimate_end_time_short: '-',
				estimate_end_time_full: '-',
				time: '-',
				time_hms: '-',
				time_seconds: '-',
				left: '-',
				left_hms: '-',
				seconds_left: '-',
				error: null
			},
			bed_cooled_down: true,
			tool_cooled_down: true,
			print_stopped: true,
			error_old: null
		}

		this._cameraSettings = this.getSettings();

		// Register capabilities
		this.registerCapabilityListener('onoff', async (value) => {
			if (value) {
				return this.octoprint.postData('/api/connection', {
					command: 'connect'
				})
					.catch(err => {
						throw new Error(err);
					})
					.then(() => {
						return true;
					});
			}
			else {
				if (this.printer.state === 'Operational') {
					return this.octoprint.postData('/api/connection', {
						command: 'disconnect'
					})
						.catch(err => {
							throw new Error(err);
						})
						.then(() => {
							return true;
						});
				}
				else {
					throw new Error(this.homey.__('error.no_printer'));
				}
			}
		});

		this.registerCapabilityListener('target_temperature.bed', async (value) => {
			if (typeof value == 'number') {
				if (
					this.printer.state === 'Operational'
					|| this.printer.state === 'Printing'
					|| this.printer.state === 'Pausing'
					|| this.printer.state === 'Paused'
				) {
					await this.octoprint.postData('/api/printer/bed', {
						'command': 'target',
						'target': value
					})
						.catch(err => {
							throw new Error(err);
						})
						.then(() => {
							return true;
						});
				}
				else {
					throw new Error(this.homey.__('error.invalid_state'));
				}
			}
			else {
				throw new Error(this.homey.__('error.invalid_value'));
			}
		});

		this.registerCapabilityListener('target_temperature.tool', async (value) => {
			if (typeof value == 'number') {
				if (
					this.printer.state === 'Operational'
					|| this.printer.state === 'Printing'
					|| this.printer.state === 'Pausing'
					|| this.printer.state === 'Paused'
				) {
					await this.octoprint.postData('/api/printer/tool', {
						'command': 'target',
						'targets': {
							'tool0': value,
						}
					})
						.catch(err => {
							throw new Error(err);
						})
						.then(() => {
							return true;
						});
				}
				else {
					throw new Error(this.homey.__('error.invalid_state'));
				}
			}
			else {
				throw new Error(this.homey.__('error.invalid_value'));
			}
		});

		this.registerCapabilityListener('target_temperature.chamber', async (value) => {
			if (typeof value == 'number') {
				if (
					this.printer.state === 'Operational'
					|| this.printer.state === 'Printing'
					|| this.printer.state === 'Pausing'
					|| this.printer.state === 'Paused'
				) {
					await this.octoprint.postData('/api/printer/chamber', {
						'command': 'target',
						'target': value
					})
						.catch(err => {
							throw new Error(err);
						})
						.then(() => {
							return true;
						});
				}
				else {
					throw new Error(this.homey.__('error.invalid_state'));
				}
			}
			else {
				throw new Error(this.homey.__('error.invalid_value'));
			}
		});

		this.registerCapabilityListener('job_pause', async (value) => {
			this.log('CapabilityListener for job_pause triggered with value:', value);

			if (value) {
				this.log('Attempting to pause the job');

				if (this.printer.state === 'Printing') {
					this.log('Printer state is Printing. Sending pause command.');

					await this.octoprint.postData('/api/job', {
						'command': 'pause',
						'action': 'pause'
					})
						.catch(err => {
							this.log('Error occurred while sending pause command:', err);
							throw new Error(err);
						})
						.then(() => {
							this.log('Pause command sent successfully');
							return true;
						});
				}
				else {
					this.log('Cannot pause print. Current printer state:', this.printer.state);
					throw new Error(this.homey.__('error.no_print'));
				}
			}
		});

		this.registerCapabilityListener('job_resume', async (value) => {
			this.log('CapabilityListener for job_resume triggered with value:', value);

			if (value) {
				this.log('Attempting to resume the job');

				if (this.printer.state === 'Pausing' || this.printer.state === 'Paused') {
					this.log('Printer state is either Pausing or Paused. Sending resume command.');
					try {
						await this.octoprint.postData('/api/job', {
							'command': 'pause',
							'action': 'resume'
						});
						this.log('Resume command sent successfully');
					} catch (err) {
						this.log('Error occurred while sending resume command:', err);
						throw new Error(err);
					} finally {
						// Reset job_resume to false after sending the command
						this.scheduleTask(async () => {
							await this.setCapabilityValue('job_resume', false);
							await this.setCapabilityValue('job_pause', false);
							this.log('Resetting job_resume capability to false');
						}, 1500);
					}
				} else {
					this.log('Cannot resume print. Current printer state:', this.printer.state);
					throw new Error(this.homey.__('error.no_pause'));
				}
			}
		});



		this.registerCapabilityListener('job_cancel', async (value) => {
			this.log('CapabilityListener for job_cancel triggered with value:', value);

			if (value) {
				if (
					this.printer.state === 'Printing'
					|| this.printer.state === 'Pausing'
					|| this.printer.state === 'Paused'
				) {
					this.log('Printer state is:', this.printer.state, '- sending cancel command');
					try {
						await this.octoprint.postData('/api/job', {
							command: 'cancel'
						});
						this.log('Cancel command sent successfully');
					} catch (err) {
						this.log('Error occurred while sending cancel command:', err);
						throw new Error(err);
					} finally {
						// Reset job_cancel to false after sending the command
						this.scheduleTask(async () => {
							await this.setCapabilityValue('job_cancel', false);
							this.log('Resetting job_cancel capability to false');
						}, 1500);
					}
				} else {
					this.log('Cannot cancel print, current printer state:', this.printer.state);
					throw new Error(this.homey.__('error.no_print'));
				}
			}
		});


		this.registerCapabilityListener('emergency_stop_m112', async (value) => {
			this.log('CapabilityListener for emergency_stop_m112 triggered with value:', value);

			if (value) {
				if (this.printer.state !== 'Closed') {
					this.log('Printer state is:', this.printer.state, '- sending emergency stop command M112');
					try {
						await this.octoprint.postData('/api/printer/command', {
							command: 'M112'
						});
						this.log('Emergency stop command sent successfully');
					} catch (err) {
						this.log('Error occurred while sending emergency stop command:', err);
						throw new Error(err);
					} finally {
						// Reset emergency_stop_m112 to false after sending the command
						this.scheduleTask(async () => {
							await this.setCapabilityValue('emergency_stop_m112', false);
							this.log('Resetting emergency_stop_m112 capability to false');
						}, 1500);
					}
				} else {
					this.log('Printer is closed, cannot send emergency stop command');
					await this.setCapabilityValue('emergency_stop_m112', false).catch(this.error);
					throw new Error(this.homey.__('error.no_printer'));
				}
			}
		});


		// Maintenance actions
		this.registerCapabilityListener('button.restart_octoprint', async (value) => {
			if (
				this.printer.state === 'Closed'
				|| this.printer.state === 'Operational'
			) {
				return this.octoprint.postData('/api/system/commands/core/restart', {})
					.catch(err => {
						throw new Error(err);
					})
					.then(() => {
						return true;
					});
			}
			else {
				throw new Error(this.homey.__('error.invalid_state'));
			}
		});

		this.registerCapabilityListener('button.reboot_raspberry', async (value) => {
			if (
				this.printer.state === 'Closed'
				|| this.printer.state === 'Operational'
			) {
				return this.octoprint.postData('/api/system/commands/core/reboot', {})
					.catch(err => {
						throw new Error(err);
					})
					.then(() => {
						return true;
					});
			}
			else {
				throw new Error(this.homey.__('error.invalid_state'));
			}
		});

		this.registerCapabilityListener('button.shutdown_raspberry', async (value) => {
			if (
				this.printer.state === 'Closed'
				|| this.printer.state === 'Operational'
			) {
				return this.octoprint.postData('/api/system/commands/core/shutdown', {})
					.catch(err => {
						throw new Error(err);
					})
					.then(() => {
						return true;
					});
			}
			else {
				throw new Error(this.homey.__('error.invalid_state'));
			}
		});

		this.startPolling();

		this.log('OctoprintDriver initialization completed');
	}

	async onAdded() {
		this.log('OctoPrint device added');
	}

	// Device's advanced settings
	async onSettings({ oldSettings, newSettings, changedKeys }) {
		if (changedKeys.length > 0) {
			const connectionChanged = changedKeys.includes('address') || changedKeys.includes('apikey');
			const client = connectionChanged ? new OctoprintAPI(newSettings) : this.octoprint;

			if (changedKeys.includes('heated_bed')) {
				if (newSettings.heated_bed) {
					if (!this.hasCapability('target_temperature.bed')) {
						await this.addCapability('target_temperature.bed').catch(this.error);
					}

					if (!this.hasCapability('measure_temperature.bed')) {
						await this.addCapability('measure_temperature.bed').catch(this.error);
					}
				}
				else {
					if (this.hasCapability('target_temperature.bed')) {
						await this.removeCapability('target_temperature.bed').catch(this.error);
					}

					if (this.hasCapability('measure_temperature.bed')) {
						await this.removeCapability('measure_temperature.bed').catch(this.error);
					}
				}
			}

			if (changedKeys.includes('heated_chamber')) {
				if (newSettings.heated_chamber) {
					if (!this.hasCapability('target_temperature.chamber')) {
						await this.addCapability('target_temperature.chamber').catch(this.error);
					}

					if (!this.hasCapability('measure_temperature.chamber')) {
						await this.addCapability('measure_temperature.chamber').catch(this.error);
					}
				}
				else if (newSettings.measured_chamber) {
					if (this.hasCapability('target_temperature.chamber')) {
						await this.removeCapability('target_temperature.chamber').catch(this.error);
					}

					if (!this.hasCapability('measure_temperature.chamber')) {
						await this.addCapability('measure_temperature.chamber').catch(this.error);
					}
				} else {
					if (this.hasCapability('target_temperature.chamber')) {
						await this.removeCapability('target_temperature.chamber').catch(this.error);
					}

					if (this.hasCapability('measure_temperature.chamber')) {
						await this.removeCapability('measure_temperature.chamber').catch(this.error);
					}
				}
			}
			else if (changedKeys.includes('measured_chamber')) {
				if (newSettings.measured_chamber) {
					if (!this.hasCapability('measure_temperature.chamber')) {
						await this.addCapability('measure_temperature.chamber').catch(this.error);
					}
				}
				else if (!newSettings.heated_chamber) {
					if (this.hasCapability('target_temperature.chamber')) {
						await this.removeCapability('target_temperature.chamber').catch(this.error);
					}

					if (this.hasCapability('measure_temperature.chamber')) {
						await this.removeCapability('measure_temperature.chamber').catch(this.error);
					}
				}
			}

			if (connectionChanged) {
				await this.stopPolling();
				this.octoprint = client;
				this.printer.server = null;
				this.printer.state = null;
				this.printer.print_stopped = true;
				this._snapshotConfig = null;
				this._streamConfig = null;
				this.log('OctoPrint connection settings updated');
			}
			await this.configureCameras(newSettings);
			if (connectionChanged) this.startPolling();

			this.log('OctoPrint settings changed:\n', changedKeys);
		}
		else {
			this.log('No settings were changed');
		}
	}

	async onRenamed(name) {
		this.log('OctoPrint device renamed', name);
	}

	scheduleTask(callback, milliseconds) {
		if (this._stopped) return;
		const timer = setTimeout(() => {
			this._timers.delete(timer);
			if (!this._stopped) Promise.resolve().then(callback).catch(error => this.error('Delayed device update failed:', error));
		}, milliseconds);
		this._timers.add(timer);
	}

	startPolling() {
		if (this._stopped || this._pollPromise) return;
		this.polling = true;
		this._pollPromise = this.pollDevice().catch(error => this.error('Polling failed:', error))
			.finally(() => { this._pollPromise = null; });
	}

	async stopPolling() {
		this.polling = false;
		if (this._pollWake) this._pollWake();
		if (this.octoprint) this.octoprint.dispose();
		await this._pollPromise;
	}

	waitForPoll(milliseconds) {
		if (!this.polling) return Promise.resolve();
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this._pollWake = null;
				resolve();
			}, milliseconds);
			this._pollWake = () => {
				clearTimeout(timer);
				this._pollWake = null;
				resolve();
			};
		});
	}

	async onDeleted() {
		this.log('OctoPrint device removed');
		await this.onUninit();
	}

	async onUninit() {
		this._stopped = true;
		for (const timer of this._timers || []) clearTimeout(timer);
		if (this._timers) this._timers.clear();
		await this.stopPolling();
		if (this._cameraQueue) await this._cameraQueue.catch(error => this.error('Camera configuration failed during cleanup:', error));
		for (const key of ['snapshotImage', 'streamVideo']) {
			if (this[key]) {
				await this[key].unregister().catch(error => this.error('Camera cleanup failed:', error));
				this[key] = null;
			}
		}
		this._snapshotConfig = null;
		this._streamConfig = null;
	}

	async pollDevice() {
		while (this.polling) {
			try {
				await this.configureCameras();
				if (!this.polling) break;
				await this.pollOnce();
			} catch (error) {
				if (!this.polling) break;
				this.printer.server = null;
				this.error('OctoPrint poll failed; retrying next interval:', error);
				await this.setUnavailable(error.message).catch(error => this.error(error));
			}
			const interval = this.getSetting('pollInterval');
			await this.waitForPoll((Number.isFinite(interval) ? Math.max(interval, 10) : 10) * 1000);
		}
	}

	async pollOnce() {
		this.printer.server = await this.octoprint.getServerState();

		if (!this.printer.server) {
			this.printer.bed_cooled_down = true;
			this.printer.tool_cooled_down = true;

			await this.setUnavailable(this.homey.__('error.server_unreachable')).catch(this.error);
			this.error('Octoprint server unreachable');
		}
		else {
			await this.setAvailable().catch(this.error);

			// Set printer temps and job
			await this.setPrinterTemps();
			await this.setPrinterJobState();

			// If there is an error
			if (this.printer.job.error) {
				if (this.printer.error_old !== this.printer.job.error) {
					this.printer.error_old = this.printer.job.error;
					this.driver.triggerError(this, { error: this.printer.job.error }, null);
				}
			}
			else {
				if (this.printer.error_old) {
					this.printer.error_old = null;
					this.driver.triggerError(this, { error: 'Error cleared' }, null);
				}
			}

			const currentState = await this.octoprint.getPrinterState();

			// Printer on off state
			if (currentState === 'Closed') {
				if (this.getCapabilityValue('onoff') === true) {
					this.printer.bed_cooled_down = true;
					this.printer.tool_cooled_down = true;

					await this.setCapabilityValue('onoff', false).catch(this.error);
				}
			}
			else {
				if (this.getCapabilityValue('onoff') === false) {
					await this.setCapabilityValue('onoff', true).catch(this.error);
				}
			}

			if (this.printer.state !== currentState) {
				// Trigger for the printer state
				const tokens = {
					state: (this.homey.__('states.' + currentState) || currentState)
				}
				await this.setCapabilityValue('printer_state', (this.homey.__('states.' + currentState) || currentState)).catch(this.error);
				if (typeof currentState === 'string') await this.driver.triggerState(this, tokens, null);

				// Started a print
				if (
					this.printer.state === 'Operational'
					&& (currentState === 'Printing'
						|| currentState === 'Starting')
				) {
					const tokens = {
						'print_started_estimate': String(this.printer.job.estimate),
						'print_started_estimate_hms': String(this.printer.job.estimate_hms),
						'print_started_estimate_seconds': parseInt(this.printer.job.estimate_seconds, 10),
						'print_started_estimate_end': String(this.printer.job.estimate_end_time),
						'print_started_estimate_end_short': String(this.printer.job.estimate_end_time_short),
						'print_started_estimate_end_full': String(this.printer.job.estimate_end_time_full)
					}

					this.printer.print_stopped = false;
					await this.driver.triggerPrintStarted(this, tokens, null);
				}

				// Paused a print
				if (
					this.printer.state === 'Printing'
					&& (currentState === 'Pausing' || currentState === 'Paused')
				) {
					// Introduce a delay for one polling cycle
					const pollInterval = Math.max(this.getSetting('pollInterval'), 10); // Ensure a minimum interval
					await this.waitForPoll(pollInterval * 1000);
					if (!this.polling) return;

					// Recheck the state after the delay
					const updatedState = await this.octoprint.getPrinterState();
					if (updatedState === 'Pausing' || updatedState === 'Paused') {
						// Proceed with triggering the print paused flow
						const tokens = {
							'print_paused_estimate': String(this.printer.job.estimate || ''),
							'print_paused_estimate_hms': String(this.printer.job.estimate_hms || ''),
							'print_paused_estimate_seconds': parseInt(this.printer.job.estimate_seconds || 0, 10),
							'print_paused_time': String(this.printer.job.time || ''),
							'print_paused_time_hms': String(this.printer.job.time_hms || ''),
							'print_paused_time_seconds': parseInt(this.printer.job.time_seconds || 0, 10),
							'print_paused_left': String(this.printer.job.left || ''),
							'print_paused_left_hms': String(this.printer.job.left_hms || 'N/A'),
							'print_paused_seconds_left': parseInt(this.printer.job.seconds_left || 0, 10),
						};

						await this.driver.triggerPrintPaused(this, tokens, null);
					} else {
						// Handle the case where the state has changed during the delay
						this.log('State changed during delay, current state:', updatedState);
					}
				}

				// Resumed a print
				if (
					(this.printer.state === 'Paused' || this.printer.state === 'Pausing')
					&& currentState === 'Printing'
				) {
					// Introduce a delay for one polling cycle
					const pollInterval = Math.max(this.getSetting('pollInterval'), 10); // Ensure a minimum interval
					await this.waitForPoll(pollInterval * 1000);
					if (!this.polling) return;

					// Recheck the state after the delay
					const updatedState = await this.octoprint.getPrinterState();
					if (updatedState === 'Printing') {
						// Proceed with triggering the print resumed flow
						const tokens = {
							'print_resumed_estimate': String(this.printer.job.estimate || ''),
							'print_resumed_estimate_hms': String(this.printer.job.estimate_hms || ''),
							'print_resumed_estimate_seconds': parseInt(this.printer.job.estimate_seconds || 0, 10),
							'print_resumed_time': this.printer.job.time || '',
							'print_resumed_time_hms': String(this.printer.job.time_hms || ''),
							'print_resumed_time_seconds': parseInt(this.printer.job.time_seconds || 0, 10),
							'print_resumed_left': String(this.printer.job.left || ''),
							'print_resumed_left_hms': String(this.printer.job.left_hms || 'N/A'),
							'print_resumed_seconds_left': parseInt(this.printer.job.seconds_left || 0, 10),
						};

						await this.driver.triggerPrintResumed(this, tokens, null);
					} else {
						// Handle the case where the state has changed during the delay
						this.log('State changed during delay, current state:', updatedState);
					}
				}


				// Finished a print
				if (
					this.printer.state === 'Printing'
					&& currentState === 'Operational'
					&& this.printer.job.completion === 100
				) {
					const tokens = {
						'print_finished_estimate': String(this.printer.job.estimate),
						'print_finished_estimate_hms': String(this.printer.job.estimate_hms),
						'print_finished_estimate_seconds': parseInt(this.printer.job.estimate_seconds, 10),
						'print_finished_time': String(this.printer.job.time),
						'print_finished_time_hms': String(this.printer.job.time_hms),
						'print_finished_time_seconds': parseInt(this.printer.job.time_seconds, 10),
					}

					await this.driver.triggerPrintFinished(this, tokens, null);
				}

				// Stopped a print
				if (
					(this.printer.state === 'Printing'
						|| this.printer.state === 'Paused'
						|| this.printer.state === 'Pausing')
					&& (currentState === 'Operational'
						|| currentState === 'Closed'
						|| currentState === 'Offline'
						|| currentState === 'Cancelling')
					&& this.printer.print_stopped === false
				) {
					const completion = this.getSetting('calculated_completion') || 'completion';

					// OctoPrint itself reports a crash/failure via the job "error" field
					// (/api/job -> error) or an "Error"/"Offline after error" connection state,
					// rather than any completion-percentage heuristic.
					const crashReason = this.printer.job.error
						|| (typeof currentState === 'string' && currentState.includes('Error') ? currentState : null);
					const isCrash = Boolean(crashReason);

					// Validate completion value
					if (typeof this.printer.job[completion] !== 'number' || isNaN(this.printer.job[completion])) {
						this.error(`Invalid value for completion: ${this.printer.job[completion]}`);
						const tokens = {
							'completion': 0,
							'completion_percent': 0
						};

						if (isCrash) {
							this.log(`Print crash detected (invalid completion): ${crashReason}`);
							await this.driver.triggerPrintCrashed(this, {
								'crash_reason': String(crashReason),
								'crash_time_elapsed': '',
								'crash_time_elapsed_seconds': 0,
								'crash_filename': String(this.printer.job.file || '')
							}, null);
						}

						this.printer.print_stopped = true;
						await this.driver.triggerPrintStopped(this, tokens, null);

					} else {
						const currentCompletion = this.printer.job[completion];
						const tokens = {
							'completion': currentCompletion,
							'completion_percent': Math.round(currentCompletion) / 100
						}

						if (isCrash) {
							this.log(`Print crash detected: ${crashReason} (completion ${currentCompletion}%)`);
							await this.driver.triggerPrintCrashed(this, {
								'crash_reason': String(crashReason),
								'crash_time_elapsed': String(this.printer.job.time || ''),
								'crash_time_elapsed_seconds': parseInt(this.printer.job.time_seconds || 0, 10),
								'crash_filename': String(this.printer.job.file || '')
							}, null);
						}

						this.printer.print_stopped = true;
						await this.driver.triggerPrintStopped(this, tokens, null);
					}
				}

				// Update the state in memory
				this.printer.state = currentState;
			}
		}

	}

	getCameraSetting(key) {
		return this._cameraSettings && Object.prototype.hasOwnProperty.call(this._cameraSettings, key)
			? this._cameraSettings[key] : this.getSetting(key);
	}

	configureCameras(settings) {
		if (settings) this._cameraSettings = { ...settings };
		const configure = async () => {
			if (this._stopped) return;
			const snapshotConfig = JSON.stringify([this.getCameraSetting('snapshot_active'),
				this.getCameraSetting('snapshot_url'), this.octoprint.address]);
			if (snapshotConfig !== this._snapshotConfig) {
				try {
					await this.setSnapshotImage();
					this._snapshotConfig = snapshotConfig;
				} catch (error) {
					this.error('Snapshot configuration failed; will retry:', error);
				}
			}
			if (this._stopped) return;
			try {
				const streamConfig = this.getStreamConfigSignature();
				if (streamConfig !== this._streamConfig) {
					await this.setStreamVideo();
					this._streamConfig = streamConfig;
				}
			} catch (error) {
				this.error('Video configuration failed; will retry:', error);
			}
		};
		this._cameraQueue = (this._cameraQueue || Promise.resolve())
			.catch(error => this.error('Previous camera configuration failed:', error))
			.then(configure);
		return this._cameraQueue;
	}

	async setSnapshotImage() {
		if (!this.getCameraSetting('snapshot_active')) {
			if (this.snapshotImage) {
				await this.snapshotImage.unregister();
				this.snapshotImage = null;
				this.log('Snapshot disabled');
			}
			return;
		}
		if (this.snapshotImage) {
			await this.snapshotImage.update();
			return;
		}
		const image = await this.homey.images.createImage();
		this.snapshotImage = image;
		image.setStream(async stream => {
			if (this._stopped || !this.getCameraSetting('snapshot_active') || this.snapshotImage !== image) {
				throw new Error(this.homey.__('error.snapshot_failed'));
			}
			const res = await this.octoprint.getSnapshot(this.sanitizeUrlInput(this.getCameraSetting('snapshot_url')));
			if (this._stopped || !this.getCameraSetting('snapshot_active') || this.snapshotImage !== image) {
				res.body.destroy();
				throw new Error(this.homey.__('error.snapshot_failed'));
			}
			await pipeline(res.body, stream);
		});
		try {
			await this.setCameraImage(OctoprintDevice.CAMERA_ID, this.homey.__('snapshot.title'), image);
		} catch (error) {
			await image.unregister().catch(cleanupError => this.error('Snapshot cleanup failed:', cleanupError));
			this.snapshotImage = null;
			throw error;
		}
	}

	isStreamActive() {
		const streamActive = this.getCameraSetting('stream_active');
		return typeof streamActive === 'boolean' ? streamActive : true;
	}

	getStreamMode() {
		const streamMode = this.getCameraSetting('stream_mode');

		if (typeof streamMode === 'string' && Object.prototype.hasOwnProperty.call(OctoprintDevice.STREAM_MODES, streamMode)) {
			return streamMode;
		}

		return this.inferStreamMode(this.getCameraSetting('stream_url'));
	}

	inferStreamMode(streamUrl) {
		const urlValue = this.sanitizeUrlInput(streamUrl);
		if (urlValue === '') {
			return 'video_auto';
		}

		const url = urlValue.toLowerCase();

		if (url.includes('/webcam/webrtc')) return 'webrtc_native';
		if (url.includes('/webcam/video.m3u8')) return 'hls';
		if (url.includes('/webcam/video.mp4')) return 'mp4';
		if (url.includes('/webcam/video.mkv')) return 'mkv';
		if (url.includes('/webcam/video')) return 'video_auto';
		if (url.includes('/webcam/?action=stream') || url.includes('/webcam/stream')) return 'mjpeg';

		return 'custom';
	}

	getEffectiveStreamMode() {
		const streamMode = this.getStreamMode();
		// Use camera-streamer's raw H.264 input supported by Homey's proxy, avoiding Matroska.
		return streamMode === 'video_auto' && !this.isWebRtcProxyDisabled() ? 'h264_proxy' : streamMode;
	}

	getSelectedStreamUrl() {
		const streamMode = this.getEffectiveStreamMode();
		if (streamMode === 'h264_proxy') return '/webcam/video.h264';

		if (streamMode === 'custom') {
			return this.sanitizeUrlInput(this.getCameraSetting('stream_url'));
		}

		return OctoprintDevice.STREAM_MODES[streamMode] || OctoprintDevice.STREAM_MODES.video_auto;
	}

	isWebRtcProxyDisabled() {
		const disableProxy = this.getCameraSetting('disable_webrtc_proxy');
		return typeof disableProxy === 'boolean' ? disableProxy : false;
	}

	getStreamConfigSignature() {
		const streamMode = this.getStreamMode();
		return [
			this.octoprint.address,
			this.isStreamActive() ? '1' : '0',
			streamMode,
			this.getSelectedStreamUrl(),
			this.isWebRtcProxyDisabled() ? '1' : '0',
			this.getEffectiveWebRtcDataChannel() ? '1' : '0',
		].join('|');
	}

	isWebRtcDataChannelEnabled() {
		const dataChannel = this.getCameraSetting('webrtc_data_channel');
		return typeof dataChannel === 'boolean' ? dataChannel : false;
	}

	getEffectiveWebRtcDataChannel(streamMode = this.getEffectiveStreamMode()) {
		return (streamMode === 'webrtc_native') ? false : this.isWebRtcDataChannelEnabled();
	}

	getCameraStreamerStatusSummary(status) {
		if (!status || !status.endpoints) {
			return null;
		}

		const summary = {};
		for (const key of ['snapshot', 'stream', 'video', 'webrtc']) {
			const endpoint = status.endpoints[key];
			if (!endpoint) {
				continue;
			}

			summary[key] = {
				enabled: endpoint.enabled === true,
				uri: typeof endpoint.uri === 'string' ? endpoint.uri : null,
			};
		}

		return summary;
	}

	async getCameraStreamerStatusSafe() {
		try {
			return await this.octoprint.getCameraStreamerStatus();
		}
		catch (error) {
			this.log('camera-streamer status unavailable', {
				error: error && error.message ? error.message : String(error),
			});
			return null;
		}
	}

	getVideoFactoryForStream(streamMode, streamUrl) {
		if (streamMode === 'webrtc_native') {
			return 'createVideoWebRTC';
		}

		if (streamMode === 'hls') {
			return 'createVideoHLS';
		}

		if (streamMode === 'custom') {
			const url = this.octoprint.getStreamUrl(streamUrl).toLowerCase();

			if (url.includes('/webrtc')) return 'createVideoWebRTC';
			if (url.startsWith('rtsp://')) return 'createVideoRTSP';
			if (url.startsWith('rtmp://')) return 'createVideoRTMP';
			if (url.includes('.m3u8')) return 'createVideoHLS';
			if (url.includes('.mpd')) return 'createVideoDASH';
		}

		return 'createVideoOther';
	}

	sanitizeUrlInput(urlValue) {
		if (typeof urlValue !== 'string') {
			return '';
		}

		return urlValue.replace(/[\r\n\t]/g, '').trim();
	}

	async setStreamVideo() {
		if (this.streamVideo && typeof this.streamVideo.unregister === 'function') {
			await this.streamVideo.unregister();
			this.streamVideo = null;
		}

		if (!this.isStreamActive()) {
			return;
		}

		if (!this.homey.videos || typeof this.homey.videos.createVideoOther !== 'function') {
			this.log('Video streaming is not supported on this Homey version.');
			return;
		}

		const streamMode = this.getStreamMode();
		const effectiveStreamMode = this.getEffectiveStreamMode();
		const selectedStreamUrl = this.getSelectedStreamUrl();

		const videoFactory = this.getVideoFactoryForStream(effectiveStreamMode, selectedStreamUrl);
		const effectiveWebRtcDataChannel = videoFactory === 'createVideoWebRTC' && this.getEffectiveWebRtcDataChannel(effectiveStreamMode);
		if (typeof this.homey.videos[videoFactory] !== 'function') {
			throw new Error(`Homey does not support ${videoFactory}`);
		}
		const createVideoFn = this.homey.videos[videoFactory].bind(this.homey.videos);
		const streamUrlResolved = this.octoprint.getStreamUrl(selectedStreamUrl);
		this.log('Configuring stream video', {
			streamMode,
			effectiveStreamMode,
			videoFactory,
			disableWebRTCProxy: this.isWebRtcProxyDisabled(),
			webrtcDataChannel: effectiveWebRtcDataChannel,
			streamUrl: OctoprintAPI.redactUrl(streamUrlResolved),
		});

		if (videoFactory === 'createVideoWebRTC') {
			this.streamVideo = await this.homey.videos.createVideoWebRTC({
				dataChannel: effectiveWebRtcDataChannel,
			});
		}
		else {
			this.streamVideo = await createVideoFn({
				disableWebRTCProxy: this.isWebRtcProxyDisabled(),
			});
		}
		const video = this.streamVideo;
		const assertActive = () => {
			if (this._stopped || !this.isStreamActive() || this.streamVideo !== video) {
				throw new Error('Camera stream is no longer active');
			}
		};

		if (videoFactory === 'createVideoWebRTC') {
			this.streamVideo.registerOfferListener(async (offerSdp) => {
				assertActive();
				this.log('WebRTC offer received from Homey frontend', {
					streamMode: effectiveStreamMode,
					offerLength: typeof offerSdp === 'string' ? offerSdp.length : 0,
				});
				const result = await this.octoprint.getWebRtcAnswer(selectedStreamUrl, offerSdp);
				assertActive();
				this.log('WebRTC answer received from camera-streamer', {
					streamMode: effectiveStreamMode,
					answerLength: typeof result.answerSdp === 'string' ? result.answerSdp.length : 0,
					streamId: result.streamId || null,
				});
				return result;
			});
		}
		else {
			this.streamVideo.registerVideoUrlListener(async () => {
				assertActive();
				const resolvedUrl = this.octoprint.getStreamUrl(selectedStreamUrl);
				this.log('Video URL requested by Homey frontend', {
					streamMode: effectiveStreamMode,
					videoFactory,
					disableWebRTCProxy: this.isWebRtcProxyDisabled(),
					resolvedUrl: OctoprintAPI.redactUrl(resolvedUrl),
				});
				return {
					url: resolvedUrl,
				};
			});
		}

		const streamTitle = this.homey.__('stream.title');
		try {
			await this.setCameraVideo(
				OctoprintDevice.CAMERA_ID,
				(typeof streamTitle === 'string' && streamTitle !== 'stream.title') ? streamTitle : 'Stream',
				video
			);
		} catch (error) {
			await video.unregister().catch(cleanupError => this.error('Video cleanup failed:', cleanupError));
			this.streamVideo = null;
			throw error;
		}
	}

	async ensureCameraSettings() {
		const updates = {};
		const currentSnapshotUrl = this.sanitizeUrlInput(this.getSetting('snapshot_url'));
		const currentStreamUrl = this.sanitizeUrlInput(this.getSetting('stream_url'));

		if (currentSnapshotUrl === '') {
			updates.snapshot_url = '/webcam/?action=snapshot';
		}
		else if (currentSnapshotUrl !== this.getSetting('snapshot_url')) {
			updates.snapshot_url = currentSnapshotUrl;
		}

		if (currentStreamUrl === '') {
			updates.stream_url = '/webcam/?action=stream';
		}
		else if (currentStreamUrl !== this.getSetting('stream_url')) {
			updates.stream_url = currentStreamUrl;
		}

		const currentStreamMode = this.getSetting('stream_mode');
		if (currentStreamMode === 'rtsp_camera_streamer') {
			updates.stream_mode = 'video_auto';
		}
		else if (typeof currentStreamMode !== 'string' || !Object.prototype.hasOwnProperty.call(OctoprintDevice.STREAM_MODES, currentStreamMode)) {
			updates.stream_mode = this.inferStreamMode(currentStreamUrl);
		}

		if (typeof this.getSetting('disable_webrtc_proxy') !== 'boolean') {
			updates.disable_webrtc_proxy = false;
		}

		if (typeof this.getSetting('webrtc_data_channel') !== 'boolean') {
			updates.webrtc_data_channel = false;
		}

		if (typeof this.getSetting('stream_active') !== 'boolean') {
			updates.stream_active = true;
		}

		if (Object.keys(updates).length > 0) {
			await this.setSettings(updates).catch(this.error);
		}
	}

	async setPrinterTemps() {
		this.printer.temp = await this.octoprint.getPrinterTemps();

		if (Object.keys(this.printer.temp).length === 0) {
			if (this.hasCapability('target_temperature.bed')) await this.setCapabilityValue('target_temperature.bed', null).catch(this.error);
			await this.setCapabilityValue('target_temperature.tool', null).catch(this.error);
			if (this.hasCapability('target_temperature.chamber')) await this.setCapabilityValue('target_temperature.chamber', null).catch(this.error);
			if (this.hasCapability('measure_temperature.bed')) await this.setCapabilityValue('measure_temperature.bed', null).catch(this.error);
			await this.setCapabilityValue('measure_temperature.tool', null).catch(this.error);
			if (this.hasCapability('measure_temperature.chamber')) await this.setCapabilityValue('measure_temperature.chamber', null).catch(this.error);

			// Backwards compatibility
			if (this.hasCapability('printer_temp_bed')) await this.setCapabilityValue('printer_temp_bed', null).catch(this.error);
			if (this.hasCapability('printer_temp_tool')) await this.setCapabilityValue('printer_temp_tool', null).catch(this.error);

			return false;
		}

		// Bed target temperature
		if (
			this.hasCapability('target_temperature.bed')
			&& this.printer.temp.bed.target != this.getCapabilityValue('target_temperature.bed')
		) {
			const temperature = (typeof this.printer.temp.bed.target === 'number') ? this.printer.temp.bed.target : null;
			const tokens = {
				temperature: temperature
			}

			await this.setCapabilityValue('target_temperature.bed', temperature).catch(this.error);
			if (temperature !== null) await this.driver.triggerBedTarget(this, tokens, null);
		}

		// Tool target temperature
		if (this.printer.temp.tool0.target != this.getCapabilityValue('target_temperature.tool')) {
			const temperature = (typeof this.printer.temp.tool0.target === 'number') ? this.printer.temp.tool0.target : null;
			const tokens = {
				temperature: temperature
			}

			await this.setCapabilityValue('target_temperature.tool', temperature).catch(this.error);
			if (temperature !== null) await this.driver.triggerToolTarget(this, tokens, null);
		}

		// Chamber target temperature
		if (
			this.hasCapability('target_temperature.chamber')
			&& this.printer.temp.chamber.target != this.getCapabilityValue('target_temperature.chamber')
		) {
			const temperature = (typeof this.printer.temp.chamber.target === 'number') ? this.printer.temp.chamber.target : null;
			const tokens = {
				temperature: temperature
			}

			await this.setCapabilityValue('target_temperature.chamber', temperature).catch(this.error);
			if (temperature !== null) await this.driver.triggerChamberTarget(this, tokens, null);
		}

		// Bed measure temperature
		const bedTemperature = (typeof this.printer.temp.bed.actual !== 'number') ? null : (!this.getSetting('measure_temperature_bed_decimal')) ? Math.round(this.printer.temp.bed.actual) : this.printer.temp.bed.actual;
		if (
			this.hasCapability('measure_temperature.bed')
			&& bedTemperature != this.getCapabilityValue('measure_temperature.bed')
		) {
			const temperature = bedTemperature;
			const tokens = {
				temperature: temperature
			}

			// Backwards compatibility
			if (this.hasCapability('printer_temp_bed')) await this.setCapabilityValue('printer_temp_bed', temperature).catch(this.error);

			await this.setCapabilityValue('measure_temperature.bed', temperature).catch(this.error);
			if (temperature !== null) await this.driver.triggerBedMeasure(this, tokens, null);

			if (
				temperature !== null && temperature < (this.getSetting('bed_cooldown_threshold') || 30)
				&& this.printer.bed_cooled_down === false
			) {
				this.driver.triggerBedCooledDown(this, null, null);
				this.printer.bed_cooled_down = true;
			}
			else if (temperature >= (this.getSetting('bed_cooldown_threshold') || 30) + 0.5) {
				this.printer.bed_cooled_down = false;
			}
		}

		// Tool measure temperature
		const toolTemperature = (typeof this.printer.temp.tool0.actual !== 'number') ? null : (!this.getSetting('measure_temperature_tool_decimal')) ? Math.round(this.printer.temp.tool0.actual) : this.printer.temp.tool0.actual;
		if (toolTemperature != this.getCapabilityValue('measure_temperature.tool')) {
			const temperature = toolTemperature;
			const tokens = {
				temperature: temperature
			}

			// Backwards compatibility
			if (this.hasCapability('printer_temp_tool')) await this.setCapabilityValue('printer_temp_tool', temperature).catch(this.error);

			await this.setCapabilityValue('measure_temperature.tool', temperature).catch(this.error);
			if (temperature !== null) await this.driver.triggerToolMeasure(this, tokens, null);

			if (
				temperature !== null && temperature < (this.getSetting('tool_cooldown_threshold') || 50)
				&& this.printer.tool_cooled_down === false
			) {
				this.driver.triggerToolCooledDown(this, null, null);
				this.printer.tool_cooled_down = true;
			}
			else if (temperature >= (this.getSetting('tool_cooldown_threshold') || 50) + 1) {
				this.printer.tool_cooled_down = false;
			}
		}

		// Chamber measure temperature
		const chamberTemperature = (typeof this.printer.temp.chamber.actual !== 'number') ? null : Math.round(this.printer.temp.chamber.actual);
		if (
			this.hasCapability('measure_temperature.chamber')
			&& chamberTemperature != this.getCapabilityValue('measure_temperature.chamber')
		) {
			const temperature = chamberTemperature;
			const tokens = {
				temperature: temperature
			}

			await this.setCapabilityValue('measure_temperature.chamber', temperature).catch(this.error);
			if (temperature !== null) await this.driver.triggerChamberMeasure(this, tokens, null);
		}
	}


	async setPrinterJobState() {
		this.printer.job = await this.octoprint.getPrinterJob(this.homey.clock.getTimezone());

		if (Object.keys(this.printer.job).length === 0) {
			await this.setCapabilityValue('measure_completion', 0).catch(this.error);
			await this.setCapabilityValue('job_estimate', null).catch(this.error);
			await this.setCapabilityValue('job_end_time', null).catch(this.error);
			await this.setCapabilityValue('job_time', null).catch(this.error);
			await this.setCapabilityValue('job_left', null).catch(this.error);
			await this.setCapabilityValue('job_file', null).catch(this.error);

			// Backwards compatibility
			if (this.hasCapability('job_completion')) await this.setCapabilityValue('job_completion', 0).catch(this.error);

			return false;
		}

		const completion = this.getSetting('calculated_completion') || 'completion';
		const estimate = (!this.getSetting('estimate_hms')) ? 'estimate' : 'estimate_hms';
		const time = (!this.getSetting('time_hms')) ? 'time' : 'time_hms';
		const left = (!this.getSetting('left_hms')) ? 'left' : 'left_hms';


		if (this.printer.job[completion] != this.getCapabilityValue('measure_completion')) {
			const tokens = {
				completion: this.printer.job[completion],
				completion_percent: Math.round(this.printer.job[completion]) / 100
			}

			// Backwards compatibility
			if (this.hasCapability('job_completion')) await this.setCapabilityValue('job_completion', this.printer.job[completion]).catch(this.error);

			await this.setCapabilityValue('measure_completion', this.printer.job[completion]).catch(this.error);
			await this.driver.triggerCompletion(this, tokens, null);

		}

		if (this.printer.job[estimate] != this.getCapabilityValue('job_estimate')) {
			const tokens = {
				time: this.printer.job.estimate,
				time_hms: this.printer.job.estimate_hms,
				seconds: this.printer.job.estimate_seconds
			}

			await this.setCapabilityValue('job_estimate', this.printer.job[estimate]).catch(this.error);
			if (this.printer.job[estimate]) await this.driver.triggerEstimatedTime(this, tokens, null);
		}

		if (this.printer.job.estimate_end_time != this.getCapabilityValue('job_end_time')) {
			const tokens = {
				time: this.printer.job.estimate_end_time,
				time_short: this.printer.job.estimate_end_time_short,
				time_full: this.printer.job.estimate_end_time_full
			}

			await this.setCapabilityValue('job_end_time', this.printer.job.estimate_end_time).catch(this.error);
			if (this.printer.job.estimate_end_time) await this.driver.triggerEstimatedEndTime(this, tokens, null);
		}

		if (this.printer.job[time] != this.getCapabilityValue('job_time')) {
			const tokens = {
				time: this.printer.job.time,
				time_hms: this.printer.job.time_hms,
				seconds: this.printer.job.time_seconds
			}

			await this.setCapabilityValue('job_time', this.printer.job[time]).catch(this.error);
			if (this.printer.job[time]) await this.driver.triggerPrintTime(this, tokens, null);
		}

		if (this.printer.job[left] != this.getCapabilityValue('job_left')) {
			const tokens = {
				time: this.printer.job.left,
				time_hms: this.printer.job.left_hms,
				seconds: this.printer.job.seconds_left
			}

			await this.setCapabilityValue('job_left', this.printer.job[left]).catch(this.error);
			if (this.printer.job[left]) await this.driver.triggerTimeLeft(this, tokens, null);
		}

		if (this.printer.job.file != this.getCapabilityValue('job_file')) {
			const fullFileName = this.printer.job.file;
			const shortenedFileName = fullFileName && fullFileName.length > 15 ? fullFileName.substring(0, 15) + "..." : fullFileName;

			// Set shortened file name as device title
			await this.setCapabilityValue('job_file', shortenedFileName).catch(this.error);

			// Use full file name in flows as a tag
			const tokens = {
				file: fullFileName // Here, use the full file name
			};
			if (fullFileName) await this.driver.triggerFile(this, tokens, null);
		}
	}

	async checkPrinterIsPrinting(args) {
		if (!this.printer.server) {
			throw new Error(this.homey.__('error.server_unreachable'));
		}

		return (
			this.printer.state === 'Printing'
			|| this.printer.state === 'Pausing'
			|| this.printer.state === 'Paused'
		)
	}

	async checkBedIsCooledDown(args) {
		if (!this.printer.server) {
			throw new Error(this.homey.__('error.server_unreachable'));
		}

		if (typeof this.getCapabilityValue('measure_temperature.bed') !== 'number') {
			throw new Error(this.homey.__('error.no_bed_temperature'));
		}

		return this.printer.bed_cooled_down;
	}

	async checkToolIsCooledDown(args) {
		if (!this.printer.server) {
			throw new Error(this.homey.__('error.server_unreachable'));
		}

		if (typeof this.getCapabilityValue('measure_temperature.tool') !== 'number') {
			throw new Error(this.homey.__('error.no_tool_temperature'));
		}

		return this.printer.tool_cooled_down;
	}

	async checkState(args) {
		if (!this.printer.server) {
			throw new Error(this.homey.__('error.server_unreachable'));
		}

		return (args.state === this.printer.state);
	}

	async cancelPrintRunListener(args, state) {
		if (
			this.printer.state === 'Printing'
			|| this.printer.state === 'Pausing'
			|| this.printer.state === 'Paused'
		) {
			return this.octoprint.postData('/api/job', {
				command: 'cancel'
			})
				.catch(err => {
					return Promise.reject(err);
				})
				.then(async () => {
					return true;
				});
		}
		else {
			return Promise.reject(this.homey.__('error.no_print'));
		}
	}

	async displayMessageRunListener(args, state) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (this.printer.state !== 'Closed') {
			return this.octoprint.postData('/api/printer/command', {
				command: 'M117 ' + args.message
			})
				.catch(err => {
					return Promise.reject(err);
				})
				.then(() => {
					return true;
				});
		}
		else {
			return Promise.reject(this.homey.__('error.no_printer'));
		}
	}

	async sendGcodeRunListener(args, state) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (typeof args.gcode !== 'string') throw new Error(this.homey.__('error.invalid_value'));
		const commands = args.gcode.split(';').map(command => command.trim()).filter(Boolean);
		if (!commands.length) throw new Error(this.homey.__('error.invalid_value'));
		const command = commands.length === 1 ? { command: commands[0] } : { commands };

		if (this.printer.state !== 'Closed') {
			return this.octoprint.postData('/api/printer/command', command)
				.catch(err => {
					return Promise.reject(err);
				})
				.then(() => {
					return true;
				});
		}
		else {
			return Promise.reject(this.homey.__('error.invalid_state'));
		}
	}

	async homePrinterRunListener(args, state) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (this.printer.state === 'Operational') {
			return this.octoprint.postData('/api/printer/command', {
				command: 'G28 ' + args.axis
			})
				.catch(err => {
					return Promise.reject(err);
				})
				.then(() => {
					return true;
				});
		}
		else {
			return Promise.reject(this.homey.__('error.no_printer'));
		}
	}

	async moveAxisRunListener(args, state) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (this.printer.state === 'Operational') {
			return this.octoprint.postData('/api/printer/command', {
				command: 'G1 ' + args.axis + Math.round(args.position) + ((typeof args.speed == 'number') ? ' F' + Math.round(args.speed) : '')
			})
				.catch(err => {
					return Promise.reject(err);
				})
				.then(() => {
					return true;
				});
		}
		else {
			return Promise.reject(this.homey.__('error.no_printer'));
		}
	}

	async emergencyStopRunListener(args, state) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (this.printer.state !== 'Closed') {
			return this.octoprint.postData('/api/printer/command', {
				command: 'M112'
			})
				.catch(err => {
					return Promise.reject(err);
				})
				.then(() => {
					return true;
				});
		}
		else {
			return Promise.reject(this.homey.__('error.no_printer'));
		}
	}

	async targetTemperatureBedRunListener(args) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (typeof args.target_temperature === 'number') {
			if (
				this.printer.state === 'Operational'
				|| this.printer.state === 'Printing'
				|| this.printer.state === 'Pausing'
				|| this.printer.state === 'Paused'
			) {
				return this.octoprint.postData('/api/printer/bed', {
					'command': 'target',
					'target': args.target_temperature
				})
					.catch(err => {
						return Promise.reject(err);
					})
					.then(() => {
						return true;
					});
			}
			else {
				return Promise.reject(this.homey.__('error.invalid_state'));
			}
		}
		else {
			return Promise.reject(this.homey.__('error.invalid_value'));
		}
	}

	async targetTemperatureToolRunListener(args) {
		if (!this.printer.server) {
			return Promise.reject(this.homey.__('error.server_unreachable'));
		}

		if (typeof args.target_temperature === 'number') {
			if (
				this.printer.state === 'Operational'
				|| this.printer.state === 'Printing'
				|| this.printer.state === 'Pausing'
				|| this.printer.state === 'Paused'
			) {
				return this.octoprint.postData('/api/printer/tool', {
					'command': 'target',
					'targets': {
						'tool0': args.target_temperature,
					}
				})
					.catch(err => {
						return Promise.reject(err);
					})
					.then(rep => {
						return true;
					});
			}
			else {
				return Promise.reject(this.homey.__('error.invalid_state'));
			}
		}
		else {
			return Promise.reject(this.homey.__('error.invalid_value'));
		}
	}

	async targetTemperatureChamberRunListener(args) {
		if (!Number.isFinite(args.target_temperature) || args.target_temperature < 0 || args.target_temperature > 75) {
			throw new Error(this.homey.__('error.invalid_value'));
		}
		if (!this.hasCapability('target_temperature.chamber')) {
			throw new Error(this.homey.__('error.invalid_state'));
		}
		await this.triggerCapabilityListener('target_temperature.chamber', args.target_temperature);
		return true;
	}

	// Listener for Reboot Raspberry Pi action
	async rebootRaspberryRunListener(args, state) {
		// Include 'Connecting' in the condition
		if (
			this.printer.state === 'Operational' ||
			this.printer.state === 'Closed' ||
			this.printer.state === 'Connecting' ||
			this.printer.state === 'Offline'
		) {
			return this.octoprint.postData('/api/system/commands/core/reboot', {})
				.then(() => true)
				.catch(error => Promise.reject(error));
		} else {
			return Promise.reject(new Error(this.homey.__('error.invalid_state')));
		}
	}

	// Listener for Shutdown Raspberry Pi action
	async shutdownRaspberryRunListener(args, state) {
		// Include 'Connecting' in the condition
		if (
			this.printer.state === 'Operational' ||
			this.printer.state === 'Closed' ||
			this.printer.state === 'Connecting' ||
			this.printer.state === 'Offline'
		) {
			return this.octoprint.postData('/api/system/commands/core/shutdown', {})
				.then(() => true)
				.catch(error => Promise.reject(error));
		} else {
			return Promise.reject(new Error(this.homey.__('error.invalid_state')));
		}
	}
}

module.exports = OctoprintDevice;
