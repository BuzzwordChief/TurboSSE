// Application-owned functions; TurboSSE supplies no built-in value transforms.
window.celsius_to_degree = function (value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) ? `${degrees.toFixed(1)} °C` : "—";
};

window.volts_to_millivolts = function (value) {
  return `${Math.round(value * 1000)} mV`;
};

// Graphs keep numeric values; presentation transforms above return text.
window.numeric_millivolts = function (value) {
  return Number(value) * 1000;
};

// Shows a status register as a 16-bit hexadecimal value; discrete lanes use the text as the value.
window.hex16 = function (value) {
  return "0x" + (Number(value) & 0xffff).toString(16).padStart(4, "0");
};
