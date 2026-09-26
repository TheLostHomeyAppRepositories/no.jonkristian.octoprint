'use strict';

const loadFetch = require('./fetch');
const { DateTime } = require("luxon");

class OctoprintAPI {
	constructor(options = {}) {
		const address = typeof options?.address === 'string' ? options.address.trim() : '';
		if (!address) throw new Error('OctoPrint address is required');
		try {
			const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`);
			if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
			this.address = url.toString().replace(/\/$/, '');
		} catch {
			throw new Error('Invalid OctoPrint HTTP(S) address');
		}
		this.apikey = options.apikey;
		this._requests = new Set();
		this._disposed = false;
	}

	static redactUrl(value) {
		try {
			const url = new URL(value);
			url.username = '';
			url.password = '';
			url.search = '';
			url.hash = '';
			return url.toString();
		} catch {
			return '[invalid URL]';
		}
	}

	dispose() {
		this._disposed = true;
		for (const controller of this._requests) controller.abort();
	}

	async request(endpoint, options, consume) {
		if (this._disposed) throw new Error('OctoPrint connection closed');
		const controller = new AbortController();
		this._requests.add(controller);
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const { default: fetch } = await loadFetch();
			const url = new URL(endpoint);
			const headers = { ...options.headers };
			if (url.username || url.password) {
				if (!headers.Authorization) {
					headers.Authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
				}
				url.username = '';
				url.password = '';
			}
			const response = await fetch(url.toString(), {
				...options,
				headers,
				signal: controller.signal,
				size: 5 * 1024 * 1024,
			});
			if (!response.ok) {
				if (response.body) response.body.destroy();
				const error = new Error(`HTTP ${response.status}`);
				error.status = response.status;
				throw error;
			}
			return await consume(response);
		} catch (error) {
			// Fetch errors may contain URLs with credentials; retain safe transport details.
			let message = controller.signal.aborted
				? (this._disposed ? 'connection closed' : 'request timed out after 10000 ms')
				: String(error.message).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, url => OctoprintAPI.redactUrl(url));
			if (this.apikey) message = message.split(this.apikey).join('[redacted]');
			const failure = new Error(`${options.method || 'GET'} ${OctoprintAPI.redactUrl(endpoint)}: ${message}`);
			failure.status = error.status;
			failure.code = error.code;
			throw failure;
		} finally {
			clearTimeout(timeout);
			this._requests.delete(controller);
		}
	}

	async getServerState() {
		const res = await this.getData('/api/server');
		if (typeof res.version !== 'string' || !res.version.trim()) {
			throw new Error('Invalid OctoPrint server response');
		}
		return res.version;
	}

	async getPrinterState() {
		const res = await this.getData('/api/connection');
		if (typeof res.current?.state !== 'string') throw new Error('Invalid OctoPrint connection response');
		return res.current.state;
	}

	async isPrinting() {
		return await this.getPrinterState() === 'Printing';
	}

	formatDuration(seconds, hms = false) {
		if (!Number.isFinite(seconds) || seconds < 0) return null;
		const total = Math.floor(seconds);
		const days = Math.floor(total / 86400);
		const hours = Math.floor(total / 3600) % 24;
		const minutes = Math.floor(total / 60) % 60;
		const remaining = total % 60;
		const time = hms
			? [hours, minutes, remaining].map(value => String(value).padStart(2, '0')).join(':')
			: `${hours}h ${minutes}m ${remaining}s`;
		return (days ? `${days}d ` : '') + time;
	}

	async getPrinterJob(tz) {
		let result = {};

		await this.getData('/api/job')
		.then(res => {
			result = {
				file: (res.job.file.name !== undefined && typeof res.job.file.name === 'string') ? res.job.file.name : null,
				completion: (res.progress.completion !== undefined && typeof res.progress.completion === 'number') ? Math.round(res.progress.completion * 10) / 10 : 0,
				completion_time_calculated: (res.progress.printTime !== undefined && typeof res.progress.printTime === 'number' && res.progress.printTimeLeft !== undefined && typeof res.progress.printTimeLeft === 'number' && res.progress.printTime >= 0 && res.progress.printTimeLeft >= 0 && Number.isFinite(res.progress.printTime + res.progress.printTimeLeft) && res.progress.printTime + res.progress.printTimeLeft > 0) ? Math.round((res.progress.printTime / (res.progress.printTime + res.progress.printTimeLeft)) * 1000) / 10 : 0,
				estimate: this.formatDuration(res.job.estimatedPrintTime),
				estimate_hms: this.formatDuration(res.job.estimatedPrintTime, true),
				estimate_seconds: (res.job.estimatedPrintTime !== undefined && typeof res.job.estimatedPrintTime === 'number') ? Math.round(res.job.estimatedPrintTime) : null,
				estimate_end_time: (res.progress.printTimeLeft !== undefined && typeof res.progress.printTimeLeft === 'number') ? DateTime.now().setZone(tz).plus({ seconds: res.progress.printTimeLeft }).toFormat('d MMM HH:mm:ss') : (res.job.estimatedPrintTime !== undefined && typeof res.job.estimatedPrintTime === 'number') ? DateTime.now().setZone(tz).plus({ seconds: res.job.estimatedPrintTime }).toFormat('d MMM HH:mm:ss') : null,
				estimate_end_time_short: (res.progress.printTimeLeft !== undefined && typeof res.progress.printTimeLeft === 'number') ? DateTime.now().setZone(tz).plus({ seconds: res.progress.printTimeLeft }).toFormat('d/M HH:mm') : (res.job.estimatedPrintTime !== undefined && typeof res.job.estimatedPrintTime === 'number') ? DateTime.now().setZone(tz).plus({ seconds: res.job.estimatedPrintTime }).toFormat('d/M HH:mm') : null,
				estimate_end_time_full: (res.progress.printTimeLeft !== undefined && typeof res.progress.printTimeLeft === 'number') ? DateTime.now().setZone(tz).plus({ seconds: res.progress.printTimeLeft }).toFormat('d MMMM HH:mm:ss') : (res.job.estimatedPrintTime !== undefined && typeof res.job.estimatedPrintTime === 'number') ? DateTime.now().setZone(tz).plus({ seconds: res.job.estimatedPrintTime }).toFormat('d MMMM HH:mm:ss') : null,
				time: this.formatDuration(res.progress.printTime),
				time_hms: this.formatDuration(res.progress.printTime, true),
				time_seconds: (res.progress.printTime !== undefined && typeof res.progress.printTime === 'number') ? res.progress.printTime : null,
				left: this.formatDuration(res.progress.printTimeLeft),
				left_hms: this.formatDuration(res.progress.printTimeLeft, true),
				seconds_left: (res.progress.printTimeLeft !== undefined && typeof res.progress.printTimeLeft === 'number') ? res.progress.printTimeLeft : null,
				error: (res.error !== undefined && typeof res.error === 'string') ? res.error : null
			};
		})
		.catch(error => {
			if (error.status !== 409) throw error;
		});

		return result;
	}

	async getPrinterErrorInfo() {
		let result = null;

		await this.getData('/api/printer/error')
		.then(res => {
			if (res.error) {
				result = {
					error: String(res.error),
					reason: (res.reason !== undefined && typeof res.reason === 'string') ? res.reason : null,
					consequence: (res.consequence !== undefined && typeof res.consequence === 'string') ? res.consequence : null,
				};
			}
		})
		.catch(error => {
			if (error.status !== 409 && error.status !== 403) throw error;
		});

		return result;
	}

	async getPrinterTemps() {
		let result = {};

		await this.getData('/api/printer')
		.then(res => {
			if (res.temperature !== undefined) {
				result = {
					bed: {
						actual: null,
						target: null
					},
					tool0: {
						actual: null,
						target: null
					},
					chamber: {
						actual: null,
						target: null
					}
				};

				if (res.temperature.bed !== undefined) {
					result.bed = {
						actual: (res.temperature.bed.actual !== undefined && typeof res.temperature.bed.actual === 'number') ? res.temperature.bed.actual : null,
						target: (res.temperature.bed.target !== undefined && typeof res.temperature.bed.target === 'number') ? res.temperature.bed.target : null
					}
				}

				if (res.temperature.tool0 !== undefined) {
					result.tool0 = {
						actual: (res.temperature.tool0.actual !== undefined && typeof res.temperature.tool0.actual === 'number') ? res.temperature.tool0.actual : null,
						target: (res.temperature.tool0.target !== undefined && typeof res.temperature.tool0.target === 'number') ? res.temperature.tool0.target : null
					}
				}

				if (res.temperature.chamber !== undefined) {
					result.chamber = {
						actual: (res.temperature.chamber.actual !== undefined && typeof res.temperature.chamber.actual === 'number') ? res.temperature.chamber.actual : null,
						target: (res.temperature.chamber.target !== undefined && typeof res.temperature.chamber.target === 'number') ? res.temperature.chamber.target : null
					}
				}
			}
		})
		.catch(error => {
			if (error.status !== 409) throw error;
		});

		return result;
	}

	async postData(path, data) {
		return this.request(this.address + path, {
			method: 'POST',
			body: JSON.stringify(data),
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer ' + this.apikey,
			},
		}, async res => {
			if (res.status === 204) return null;
			const body = await res.text();
			return body.trim() ? JSON.parse(body) : null;
		});
	}

	async getData(path) {
		return this.request(this.address + path, {
			headers: { 'Authorization': 'Bearer ' + this.apikey },
		}, res => res.json());
	}

	getWebcamUrl(endpoint, defaultPath) {
		const value = typeof endpoint === 'string' ? endpoint.replace(/[\r\n\t]/g, '').trim() : '';
		const base = `${this.address}/`;
		try {
			if (!value) return new URL(defaultPath, base).toString();
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return new URL(value).toString();
			// Dotted hosts, localhost, and explicit ports preserve legacy host/path inputs.
			if (/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost|[a-z0-9-]+:\d+)(?::\d+)?\//i.test(value)
				|| /^(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|[a-z0-9.-]+:\d+)$/.test(value)) {
				return new URL(`${new URL(base).protocol}//${value}`).toString();
			}
			return new URL(value, base).toString();
		} catch {
			// URL errors include the raw input, which may contain camera credentials.
			throw new Error('Invalid camera URL');
		}
	}

	async getSnapshot(endpoint) {
		const address = this.getWebcamUrl(endpoint, '/webcam/?action=snapshot');
		// Buffer within the bounded request so a stalled response body cannot hang Homey's image stream.
		return this.request(address, {}, async res => {
			const { Response } = await loadFetch();
			return new Response(Buffer.from(await res.arrayBuffer()), { status: res.status, headers: res.headers });
		});
	}

	getStreamUrl(endpoint) {
		return this.getWebcamUrl(endpoint, '/webcam/?action=stream');
	}

	async getCameraStreamerStatus() {
		const endpoint = this.getWebcamUrl('/webcam/status', '/webcam/status');
		return this.request(endpoint, {}, res => res.json());
	}

	async getWebRtcAnswer(endpoint, offerSdp) {
		const address = this.getWebcamUrl(endpoint, '/webcam/webrtc');
		const offerCandidateCount = typeof offerSdp === 'string'
			? (offerSdp.match(/^a=candidate:/gm) || []).length
			: 0;
		const offerHasH264 = typeof offerSdp === 'string' && /H264/i.test(offerSdp);
		console.log('[OctoPrint] Sending WebRTC offer to camera-streamer', {
			address: OctoprintAPI.redactUrl(address),
			offerLength: typeof offerSdp === 'string' ? offerSdp.length : 0,
			offerCandidateCount,
			offerHasH264,
		});
		const payload = await this.request(address, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				type: 'offer',
				sdp: offerSdp,
				keepAlive: false,
			})
		}, res => res.json());

		if (typeof payload.sdp !== 'string' || !payload.sdp.trim()) {
			throw new Error('WebRTC signaling returned an invalid SDP answer');
		}

		const answerCandidateIps = [];
		const answerConnectionIps = [];
		for (const line of payload.sdp.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.startsWith('a=candidate:')) {
				const parts = trimmed.split(/\s+/);
				if (parts.length >= 6) {
					answerCandidateIps.push(parts[4]);
				}
			}
			if (trimmed.startsWith('c=')) {
				const parts = trimmed.split(/\s+/);
				if (parts.length >= 3) {
					answerConnectionIps.push(parts[2]);
				}
			}
		}

		console.log('[OctoPrint] WebRTC answer received', {
			answerLength: payload.sdp.length,
			streamId: payload.id || null,
			answerCandidateCount: (payload.sdp.match(/^a=candidate:/gm) || []).length,
			answerHasH264: /H264/i.test(payload.sdp),
			answerCandidateIps: [...new Set(answerCandidateIps)],
			answerConnectionIps: [...new Set(answerConnectionIps)],
		});
		return {
			answerSdp: payload.sdp,
			streamId: payload.id,
		};
	}
}

module.exports = { OctoprintAPI };
