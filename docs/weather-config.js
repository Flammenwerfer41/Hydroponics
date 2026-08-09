(() => {
  const cloudOrigin = "https://hydroponics-jma-weather.woosukang.workers.dev";
  const dataApiBaseUrl = window.location.origin === cloudOrigin ? "" : cloudOrigin;

  window.HYDROPONICS_CONFIG = Object.freeze({
    dataApiBaseUrl,
    weatherApiUrl: `${dataApiBaseUrl}/v1/current`
  });
})();
