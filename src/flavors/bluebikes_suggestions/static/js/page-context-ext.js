// This extension places additional data into the context for pages
// (specifically the overview page), useful for rendering the map legend and
// data about the timeframe during which suggestions have been accepted.

(function() {
  const Shareabouts_AppView_getPageTemplateContext = Shareabouts.AppView.prototype.getPageTemplateContext;
  Shareabouts.AppView.prototype.getPageTemplateContext = function(slug) {
    const context = Shareabouts_AppView_getPageTemplateContext.call(this, slug);

    context.oldestSuggestionDatetime = new Date(Shareabouts.Config.place.earliest_submission_date);
    context.oldestSuggestionReadableDatetime = context.oldestSuggestionDatetime
                                               ? Shareabouts.Util.getPrettyDateTime(context.oldestSuggestionDatetime)
                                               : null;

    return context;
  }
})();