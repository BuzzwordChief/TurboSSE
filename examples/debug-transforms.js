// Application-owned functions; TurboSSE supplies no built-in value transforms.
window.celsius_to_degree = function (value) {
  const degrees = Number(value);
  return Number.isFinite(degrees) ? `${degrees.toFixed(1)} °C` : "—";
};

window.volts_to_millivolts = function (value) {
  return `${Math.round(value * 1000)} mV`;
};
