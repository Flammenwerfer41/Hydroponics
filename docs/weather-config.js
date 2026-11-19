(() => {
  const cloudOrigin = "https://hydroponics-jma-weather.flammenwerfer41.workers.dev";
  const localWorker = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const workerOrigin = localWorker ? window.location.origin : cloudOrigin;
  const dataApiBaseUrl = window.location.origin === workerOrigin ? "" : workerOrigin;

  window.HYDROPONICS_CONFIG = Object.freeze({
    dataApiBaseUrl,
    // Balcony sensor commissioning confirmed; JMA remains an independent source.
    balconyWeatherEnabled: true,
    weatherApiUrl: `${dataApiBaseUrl}/v1/current`
  });
})();
