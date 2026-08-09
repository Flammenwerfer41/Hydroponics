(() => {
  const cloudOrigin = "https://hydroponics-jma-weather.flammenwerfer41.workers.dev";
  const dataApiBaseUrl = window.location.origin === cloudOrigin ? "" : cloudOrigin;

  window.HYDROPONICS_CONFIG = Object.freeze({
    dataApiBaseUrl,
    weatherApiUrl: `${dataApiBaseUrl}/v1/current`
  });
})();
