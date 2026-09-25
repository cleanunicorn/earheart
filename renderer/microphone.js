// Shared microphone constraints and error classification for the overlay.

function microphoneConstraints(deviceId) {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

function isMissingMicrophone(error) {
  return error?.name === "OverconstrainedError" && error?.constraint === "deviceId";
}

function microphoneErrorMessage(error) {
  const detail = error?.message || error?.name || "Unknown microphone error";
  return `Microphone unavailable: ${detail}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    microphoneConstraints,
    isMissingMicrophone,
    microphoneErrorMessage,
  };
}
