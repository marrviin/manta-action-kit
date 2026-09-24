/**
 * Shared site engine: bilingual toggle + nav active state.
 *
 * Pages declare translations as `window.MANTA_I18N = { zh: { key: html, ... } }`
 * (the inline HTML is the English source of truth; the `zh` dict overrides it).
 * Elements opt in with `data-i18n="key"`. Switching to English restores the
 * cached original innerHTML, so no `en` dictionary is needed.
 */
(function () {
  var els = Array.prototype.slice.call(document.querySelectorAll("[data-i18n]"));
  var cache = {};
  els.forEach(function (el) {
    cache[el.getAttribute("data-i18n")] = el.innerHTML;
  });

  var switcher = document.getElementById("langSwitch");
  var dicts = window.MANTA_I18N || {};

  var stored = null;
  try { stored = localStorage.getItem("manta-lang"); } catch (e) {}
  var lang = stored === "en" || stored === "zh"
    ? stored
    : (navigator.language || "en").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";

  function apply() {
    var dict = dicts[lang] || {};
    els.forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var html = key in dict ? dict[key] : cache[key];
      if (html != null) el.innerHTML = html;
    });
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    if (switcher) {
      Array.prototype.forEach.call(switcher.querySelectorAll(".lang-opt"), function (opt) {
        opt.classList.toggle("active", opt.getAttribute("data-lang") === lang);
      });
    }
  }

  if (switcher) {
    switcher.addEventListener("click", function (e) {
      var opt = e.target.closest(".lang-opt");
      if (!opt) return;
      lang = opt.getAttribute("data-lang") === "zh" ? "zh" : "en";
      try { localStorage.setItem("manta-lang", lang); } catch (err) {}
      apply();
    });
  }

  apply();

  // Highlight the current page in the nav.
  var page = document.body.getAttribute("data-page");
  if (page) {
    var link = document.querySelector('.nav-link[data-page="' + page + '"]');
    if (link) link.classList.add("active");
  }

  // Exposed for pages that render content after load (e.g. changelog).
  window.MantaSite = { lang: function () { return lang; } };
})();
