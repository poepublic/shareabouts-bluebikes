// This extension to the PlaceFormView allows us to set a custom validity
// message on form fields.

(function() {
  Shareabouts.PlaceFormView.prototype.events = {
    ...Shareabouts.PlaceFormView.prototype.events,
    'change [data-custom-validity]': 'onInputWithCustomValidityChange',
  };

  Shareabouts.PlaceFormView.prototype.updateValidity = function(input) {
    input.setCustomValidity(''); // Clear any previous custom validity message
    if (input.checkValidity()) {
      return; // If the input is valid, no need to set a custom validity message
    }
    
    // If the input is not valid, set the custom validity message from the
    // data-custom-validity attribute.
    // This allows us to override the default validation message with a custom one.
    const customValidity = input.getAttribute('data-custom-validity');
    if (customValidity) {
      input.setCustomValidity(customValidity);
    } else {
      input.setCustomValidity('');
    }
  }

  Shareabouts.PlaceFormView.prototype.updateAllValidity = function() {
    // Update the validity of all inputs with a data-custom-validity attribute.
    this.el.querySelectorAll('[data-custom-validity]').forEach((input) => {
      this.updateValidity(input);
    });
  }

  Shareabouts.PlaceFormView.prototype.onInputWithCustomValidityChange = function(event) {
    const input = event.target;
    // this.updateValidity(input);
    this.updateAllValidity(); // Update all inputs with custom validity messages
  }

  const Shareabouts_PlaceFormView_render = Shareabouts.PlaceFormView.prototype.render;
  Shareabouts.PlaceFormView.prototype.render = function() {
    Shareabouts_PlaceFormView_render.apply(this, arguments);

    this.updateAllValidity();

    return this;
  }

})();