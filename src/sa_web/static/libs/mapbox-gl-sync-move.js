// Adapted from https://github.com/mapbox/mapbox-gl-sync-move/blob/0.3.1/index.js
//
// In the original, the `syncMaps` function was exported via `module.exports`.

function moveToMapPosition (master, clones) {
  var center = master.getCenter();
  var zoom = master.getZoom();

  clones.forEach(function (clone) {
    clone.jumpTo({
      center: center,
      zoom: zoom,
    });
  });
}

// Sync movements of two maps.
//
// All interactions that result in movement end up firing
// a "move" event. The trick here, though, is to
// ensure that movements don't cycle from one map
// to the other and back again, because such a cycle
// - could cause an infinite loop
// - prematurely halts prolonged movements like
//   double-click zooming, box-zooming, and flying
function syncMaps (...maps) {

  // Create all the movement functions, because if they're created every time
  // they wouldn't be the same and couldn't be removed.
  var fns = [];
  maps.forEach(function (map, index) {
    fns[index] = sync.bind(null, map, maps.filter(function (_, i) { return i !== index; }));
  });

  function on () {
    maps.forEach(function (map, index) {
      map.on('move', fns[index]);
    });
  }

  function off () {
    maps.forEach(function (map, index) {
      map.off('move', fns[index]);
    });
  }

  // When one map moves, we turn off the movement listeners
  // on all the maps, move it, then turn the listeners on again
  function sync (master, clones) {
    off();
    moveToMapPosition(master, clones);
    on();
  }

  on();
  return function(){  off(); fns = []; maps = []; };
}

// module.exports = syncMaps;
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = syncMaps;
}