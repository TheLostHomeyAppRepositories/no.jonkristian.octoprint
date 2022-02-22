# Octoprint
[OctoPrint](https://octoprint.org) is a web interface for your 3D printer. This is the app integration for Homey.

## Instructions
[Download](https://github.com/caseda/no.jonkristian.octoprint/archive/master.zip) and extract the latest code and type ``npm install`` from inside the folder, it will install app dependencies, then you can type ``homey app install`` or ```homey app run``` if you want to run it from the terminal. Once it's running you can add your octoprint server as a device. If you have any issues or feature suggestions please report them [here](https://github.com/caseda/no.jonkristian.octoprint/issues).

## Features
* Printer connect/disconnect
* Printer state(s)
* Bed temperature (target and current)
* Tool temperature (target and current)
* Chamber temperature (target and current)
* Estimated print time
* Estimated time left
* Estimated end time
* Print time
* Print percentage completed
* Current file name
* Pause print (Button)
* Resume print (Button)
* Cancel print (Button, double press!)
* Emergency stop (Button, double press!)
* Snapshot

## Trigger cards
* Print started (tags: estimated print time (normal/H:M:S/seconds), estimated end time (normal/short/full))
* Print paused (tags: estimated print time (normal/H:M:S/seconds), print time (normal/H:M:S/seconds), estimated time left (normal/H:M:S/seconds))
* Print finished (tags: estimated print time (normal/H:M:S/seconds), print time (normal/H:M:S/seconds))
* State changed (tags: state)
* Bed temperature changed (target and current)
* Tool temperature changed (target and current)
* Chamber temperature changed (target and current)
* Bed cooled down
* Tool cooled down
* Estimated print time changed (tags: normal/H:M:S/seconds)
* Estimated end time changed (tags: normal/short/full)
* Print time changed (tags: normal/H:M:S/seconds)
* Print percentage completed changed (tags: from API (normal/percentage), calculated (normal/percentage))
* Error occurred (tags: error)
* File (name) changed (tags: file)

## Condition cards
* Is (not) printing
* State is (not) ... (Operational, Offline, Printing, Pausing, Paused, Connecting, Detecting connection)
* Bed is (not) cooled down
* Tool is (not) cooled down

## Action cards
* Cancel print
* Home axis (G28) ... (optional argument(s)) (when not printing)
* Move axis (G1) [Axis] to [Position] with speed [Speed] (optional speed argument) (when not printing)
* Display a message
* Send a G-Code (Just be careful with this one!)
* Emergency stop (M112)
* Set the bed temperature
* Set the tool temperature
* Set the chamber temperature

## Device settings
* IP Address
* API Key
* Polling interval
* Use snapshot
* Snapshot URL
* Heated bed
* Heated chamber
* Measured chamber temperature
* Accurate bed temperature (1 decimal)
* Accurate tool temperature (1 decimal)
* Use calculated completion percentage (standard (file position) or time calculated)
* Bed cooldown threshold
* Tool cooldown threshold
* H:M:S for estimated time
* H:M:S for print time
* H:M:S for time left

## Maintenance Actions
* Restart Octoprint (when not printing)
* Reboot Raspberry Pi (when not printing)
* Shutdown Raspberry Pi (when not printing)

## Feedback
⭐️ this repository if you found it useful ❤️

<a href="https://www.buymeacoffee.com/jonkristian" target="_blank"><img src="https://bmc-cdn.nyc3.digitaloceanspaces.com/BMC-button-images/custom_images/white_img.png" alt="Buy Me A Coffee" style="height: auto !important;width: auto !important;" ></a>

## Notes:
I did look at the push capabilities Octoprint has, but they are still changing this part of the API.
I wanted to have this app keep working even if they do change the Push API, so I won't be implementing this yet.
The app will stay like it is for now, polling the current state(s), on a adjustable interval (minimal 10 seconds).

## Icon attribution
* The App icon "Tentacle" belongs to [OctoPrint](https://octoprint.org).
* The Device icon "3D Printer" is made by [Freepik](https://www.freepik.com) from [www.flaticon.com](https://www.flaticon.com).
* The Store icon "3D Printer" is made by [Ahkâm](https://www.freeiconspng.com/img/13046)

## Release Notes
#### 1.1.0
- Changed capabilities (breaking changes if (any) tokens/tags were used of these 3 capabilities in flows):
  - printer_temp_bed => measure_temperature.bed (Current bed temperature) (eligible as device indicator now)
  - printer_temp_tool => measure_temperature.tool (Current tool temperature) (eligible as device indicator now)
  - job_completion => measure_completion (Print completion) (eligible as device indicator now)
- Added capabilities:
  - Bed target temperature (target_temperature.bed, 0°C - 130°C) (enabled by default, able to disable)
  - Tool target temperature (target_temperature.tool, 0°C - 300°C)
  - Chamber target temperature (target_temperature.chamber, 0°C - 75°C) (disabled by default, able to enable)
  - Current chamber temperature (measure_temperature.chamber) (eligible as device indicator)
  - Print file (job_file)
  - Estimated end time (job_end_time)
  - Emergency Stop (emergency_stop_m112) (button, double press is mandatory!)
- Added flow cards:
  - Triggers:
    - Bed target temperature changed
    - Tool target temperature changed
    - Chamber target temperature changed
    - Current bed temperature changed
    - Current tool temperature changed
    - Current chamber temperature changed
    - Bed cooled down
    - Tool cooled down
    - Estimated time changed
    - Estimated end time changed
    - Completion percentage changed
    - Print time changed
    - Time left changed
    - Octoprint state changed
    - Print file changed
    - An error occurred
  - Conditions:
    - Octoprint's state
    - Bed is (not) cooled down
    - Tool is (not) cooled down
  - Actions:
    - Home axis (G28)
    - Move axis (G1)
    - Display a message (M117)
    - Send G-Code
    - Emergency stop (M112)
    - Set bed temperature (0°C - 130°C)
    - Set tool temperature (0°C - 300°C)
    - Set chamber temperature (0°C - 75°C)
- Maintenance Actions:
  - Restart Octoprint
  - Reboot Raspberry Pi
  - Shutdown Raspberry Pi
- Device (advanced) settings:
  - IP address, easier to change if the IP ever changed without having the re-pair the printer
  - API Key easier to change if the API Key ever changed without having the re-pair the printer
  - Polling interval, can now be set on different intervals per printer, instead of a global interval
  - Heated bed, enables/disables all heated bed features (capabilities and flow cards)
  - Heated chamber, enables/disables all heated chamber features (capabilities and flow cards)
  - Measured chamber temperature, enables/disables all measured chamber temperature features (capabilities and flow cards) (is ignored when heated chamber is enabled)
  - Accurate bed temperature, if the temperature should have a decimal or not
  - Accurate tool temperature, if the temperature should have a decimal or not
  - Bed cooldown threshold
  - Tool cooldown threshold
  - Completion percentage, option to calculate the percentage based on print time and time left, the one in the API (based on file position) isn't always that accurate
  - H:M:S for estimated time, if you like the H:M:S style of showing time better, both options are in the trigger card (TTS handels H:M:S better)
  - H:M:S for print time, if you like the H:M:S style of showing time better, both options are in the trigger card (TTS handels H:M:S better)
  - H:M:S for time left, if you like the H:M:S style of showing time better, both options are in the trigger card (TTS handels H:M:S better)
- Other changes:
  - Fixed on/off capabilities' behaviour
  - Changed how the time is displayed in the capability, now with seconds and when necessary day(s)
  - Made the cancel print (GUI) button mandatory to double press it, to prevent accidental presses
  - Added Dutch translation
  - Many minor changes to the internal behaviour, to make it more reliable

#### 1.0.9
- Fixed run listener init
- Adds camera in-app

#### 1.0.8
- Fixed 'flow_token_already_exists' error
- Minor translation fixes

#### 1.0.7
- Homey SDK v3
- Adds missing printer state translations
- Easier/Quicker setup
- Snapshot config moved to advanced settings
- Snapshot is now a global token (tag)
- Buttons are now functional
- Adds trigger card for print paused
- Fixed off trigger when it shouldn't
- Adds homey community topic id
- Adds loading overlay in setup

#### 1.0.6
- Changed sensor state value to '-' when undefined
- Translation fix for printer state
- Better handling of undefined checks on nested properties
- Added option to specify webcam/snapshot url when adding device

#### 1.0.5
- Fixed wrong nozzle temperature readings

#### 1.0.4
- Athom Homey app review issues

#### 1.0.3
- Athom Homey app review issues

#### 1.0.2
- Wrong json entry in app.json

#### 1.0.1
- Modified descriptions & added source and bugs url.

#### 1.0.0
- Stable for app store.
