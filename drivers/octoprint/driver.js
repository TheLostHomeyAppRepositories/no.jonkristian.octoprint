'use strict';

const Homey = require('homey');
const { OctoprintAPI } = require('../../lib/octoprint.js');

class OctoprintDriver extends Homey.Driver {
    /**
     * onInit is called when the driver is initialized.
     */
    async onInit() {
        this.log('Printer has been initialized');

        this.previousStates = {};

        //  ========================================== Flow trigger registers ==========================================
        this._printStartedTrigger = this.homey.flow.getDeviceTriggerCard('print_started');
        this._printPausedTrigger = this.homey.flow.getDeviceTriggerCard('print_paused');
        this._printResumedTrigger = this.homey.flow.getDeviceTriggerCard('print_resumed');
        this._printFinishedTrigger = this.homey.flow.getDeviceTriggerCard('print_finished');
        this._printStoppedTrigger = this.homey.flow.getDeviceTriggerCard('print_stopped');
        this._targetTemperatureBedTrigger = this.homey.flow.getDeviceTriggerCard('target_temperature_changed_bed');
        this._targetTemperatureToolTrigger = this.homey.flow.getDeviceTriggerCard('target_temperature_changed_tool');
        this._targetTemperatureChamberTrigger = this.homey.flow.getDeviceTriggerCard('target_temperature_changed_chamber');
        this._measureTemperatureBedTrigger = this.homey.flow.getDeviceTriggerCard('measure_temperature_changed_bed');
        this._measureTemperatureToolTrigger = this.homey.flow.getDeviceTriggerCard('measure_temperature_changed_tool');
        this._measureTemperatureChamberTrigger = this.homey.flow.getDeviceTriggerCard('measure_temperature_changed_chamber');
        this._estimatedTimeTrigger = this.homey.flow.getDeviceTriggerCard('estimated_time_changed');
        this._completionTrigger = this.homey.flow.getDeviceTriggerCard('completion_changed');
        this._endTimeTrigger = this.homey.flow.getDeviceTriggerCard('estimated_end_time_changed');
        this._printTimeTrigger = this.homey.flow.getDeviceTriggerCard('print_time_changed');
        this._timeLeftTrigger = this.homey.flow.getDeviceTriggerCard('time_left_changed');
        this._stateTrigger = this.homey.flow.getDeviceTriggerCard('state_changed');
        this._fileTrigger = this.homey.flow.getDeviceTriggerCard('file_changed');
        this._bedCooledDownTrigger = this.homey.flow.getDeviceTriggerCard('bed_cooled_down');
        this._toolCooledDownTrigger = this.homey.flow.getDeviceTriggerCard('tool_cooled_down');
        this._errorTrigger = this.homey.flow.getDeviceTriggerCard('error_occurred');

        //  ========================================== Flow action registers ==========================================
        this._actionCancelPrint = this.homey.flow.getActionCard('cancel_print')
            .registerRunListener((args, state) => {
                this.log('Cancel print action triggered');
                return args.device.cancelPrintRunListener(args, state);
            });

        this._actionchangeFilament = this.homey.flow.getActionCard('send_g_code')
            .registerRunListener((args, state) => {
                return args.device.sendGcodeRunListener(args, state);
            });

        this._actionHomePrinter = this.homey.flow.getActionCard('home_printer')
            .registerRunListener((args, state) => {
                this.log('Home action triggered');
                return args.device.homePrinterRunListener(args, state);
            });

        this._actionDisplayMessage = this.homey.flow.getActionCard('display_message')
            .registerRunListener((args, state) => {
                this.log('Display message action triggered');
                return args.device.displayMessageRunListener(args, state);
            });

        this._actionMoveAxis = this.homey.flow.getActionCard('move_axis')
            .registerRunListener((args, state) => {
                this.log('Move axis action triggered');
                return args.device.moveAxisRunListener(args, state);
            });

        this._actionEmergencyStop = this.homey.flow.getActionCard('emergency_stop_m112')
            .registerRunListener((args, state) => {
                this.log('Emergency stop action triggered');
                return args.device.emergencyStopRunListener(args, state);
            });

        this._targetTemperatureBed = this.homey.flow.getActionCard('target_temperature_set_bed')
            .registerRunListener((args, state) => {
                return args.device.targetTemperatureBedRunListener(args, state);
            });

        this._targetTemperatureTool = this.homey.flow.getActionCard('target_temperature_set_tool')
            .registerRunListener((args, state) => {
                return args.device.targetTemperatureToolRunListener(args, state);
            });
            
        // Register Reboot Raspberry Pi action card
        this._actionRebootRaspberry = this.homey.flow.getActionCard('reboot_raspberry')
            .registerRunListener((args, state) => {
                return args.device.rebootRaspberryRunListener(args, state);
            });

        // Register Shutdown Raspberry Pi action card
        this._actionShutdownRaspberry = this.homey.flow.getActionCard('shutdown_raspberry')
            .registerRunListener((args, state) => {
                return args.device.shutdownRaspberryRunListener(args, state);
            });

        //  ========================================== Flow condition registers ==========================================
        this._isPrinting = this.homey.flow.getConditionCard('is_printing')
            .registerRunListener(args => {
                return args.device.checkPrinterIsPrinting(args);
            });

        this._bedCooledDown = this.homey.flow.getConditionCard('bed_cooled_down')
            .registerRunListener(args => {
                return args.device.checkBedIsCooledDown(args);
            });

        this._toolCooledDown = this.homey.flow.getConditionCard('tool_cooled_down')
            .registerRunListener(args => {
                return args.device.checkToolIsCooledDown(args);
            });

        this._printerState = this.homey.flow.getConditionCard('octroprint_state')
            .registerRunListener(args => {
                return args.device.checkState(args);
            });
    }

    /**
     * Generic trigger method with change detection
     */
    triggerEvent(eventName, device, tokens, state) {
        const prev = this.previousStates[eventName];
        const current = tokens;
        const isChanged = JSON.stringify(prev) !== JSON.stringify(current);
        if (isChanged) {
            this.log(`${eventName.toUpperCase()} :`, tokens);
            const trigger = this[`_${eventName}Trigger`];
            if (trigger) {
                trigger.trigger(device, tokens, state).catch(err => {
                    this.log(`Error triggering ${eventName.toUpperCase()}:`, err);
                });
            }
            this.previousStates[eventName] = JSON.parse(JSON.stringify(current));
        }
    }

    //  ========================================== Flow triggers ==========================================
    triggerPrintStarted(device, tokens, state) {
        this.triggerEvent('printStarted', device, tokens, state);
    }

    triggerPrintPaused(device, tokens, state) {
        this.triggerEvent('printPaused', device, tokens, state);
    }

    triggerPrintResumed(device, tokens, state) {
        this.triggerEvent('printResumed', device, tokens, state);
    }

    triggerPrintFinished(device, tokens, state) {
        this.triggerEvent('printFinished', device, tokens, state);
    }

    triggerPrintStopped(device, tokens, state) {
        this.triggerEvent('printStopped', device, tokens, state);
    }

    triggerBedTarget(device, tokens, state) {
        this.triggerEvent('targetTemperatureBed', device, tokens, state);
    }

    triggerToolTarget(device, tokens, state) {
        this.triggerEvent('targetTemperatureTool', device, tokens, state);
    }

    triggerChamberTarget(device, tokens, state) {
        this.triggerEvent('targetTemperatureChamber', device, tokens, state);
    }

    triggerBedMeasure(device, tokens, state) {
        this.triggerEvent('measureTemperatureBed', device, tokens, state);
    }

    triggerToolMeasure(device, tokens, state) {
        this.triggerEvent('measureTemperatureTool', device, tokens, state);
    }

    triggerChamberMeasure(device, tokens, state) {
        this.triggerEvent('measureTemperatureChamber', device, tokens, state);
    }

    triggerEstimatedTime(device, tokens, state) {
        this.triggerEvent('estimatedTime', device, tokens, state);
    }

    triggerEstimatedEndTime(device, tokens, state) {
        this.triggerEvent('estimatedEndTime', device, tokens, state);
    }

    triggerCompletion(device, tokens, state) {
        this.triggerEvent('completion', device, tokens, state);
    }

    triggerPrintTime(device, tokens, state) {
        this.triggerEvent('printTime', device, tokens, state);
    }

    triggerTimeLeft(device, tokens, state) {
        this.triggerEvent('timeLeft', device, tokens, state);
    }

    triggerState(device, tokens, state) {
        this.triggerEvent('state', device, tokens, state);
    }

    triggerFile(device, tokens, state) {
        this.triggerEvent('file', device, tokens, state);
    }

    triggerBedCooledDown(device, tokens, state) {
        this.triggerEvent('bedCooledDown', device, tokens, state);
    }

    triggerToolCooledDown(device, tokens, state) {
        this.triggerEvent('toolCooledDown', device, tokens, state);
    }

    triggerError(device, tokens, state) {
        this.triggerEvent('error', device, tokens, state);
    }

    async onPair(session) {
        session.setHandler('showView', async (viewId) => {
            this.log('Pairing view changed to:', viewId);
            if ('start' === viewId) {
                session.setHandler('addOctoprint', async function(connection) {
                    // Test connection, see if we can retrieve octoprint version.
                    const octoprint = new OctoprintAPI(connection);
                    return await octoprint.getServerState().catch(error => console.log(error));
                });
            }
        });
    }

    async onPairListDevices() {
    }
}

module.exports = OctoprintDriver;
