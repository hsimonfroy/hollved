/**
 * This component shows basic navigation help. The idea is to show it only
 * first time when user opens. All subsequent page opening should not trigger
 * help screen.
 *
 * The only possible way to show help again is by triggering "show help"
 * action, which is currently bound to mouse wheel event
 */
import { useState, useEffect } from 'react';
import appEvents from './service/appEvents.js';
import Key from './utils/key.js';

var helpWasShown = false;

export default function Help() {
  var [, setTick] = useState(0);
  var [graphDownloaded, setGraphDownloaded] = useState(false);

  useEffect(function() {
    if (window.orientation !== undefined) return;

    function showHelpIfNeeded() {
      if (helpWasShown) return;
      setGraphDownloaded(true);
    }

    function toggleHelp() {
      helpWasShown = !helpWasShown;
      setTick(function(t) { return t + 1; });
    }

    function resetHelp() {
      setGraphDownloaded(false);
    }

    function handlekey(e) {
      if (Key.isModifier(e)) return;
      var needsUpdate = !helpWasShown;
      helpWasShown = true;
      if (needsUpdate) setTick(function(t) { return t + 1; });
    }

    function handlewheel(e) {
      if (e.target && e.target.nodeName === 'CANVAS') {
        helpWasShown = false;
        setTick(function(t) { return t + 1; });
        appEvents.focusScene.fire();
      }
    }

    appEvents.graphDownloaded.on(showHelpIfNeeded);
    appEvents.downloadGraphRequested.on(resetHelp);
    appEvents.toggleHelp.on(toggleHelp);
    document.body.addEventListener('keydown', handlekey);
    document.body.addEventListener('wheel', handlewheel, true);

    return function() {
      appEvents.graphDownloaded.off(showHelpIfNeeded);
      appEvents.downloadGraphRequested.off(resetHelp);
      appEvents.toggleHelp.off(toggleHelp);
      document.body.removeEventListener('keydown', handlekey);
      document.body.removeEventListener('wheel', handlewheel, true);
    };
  }, []);

  if (window.orientation !== undefined) return null;
  if (helpWasShown) return null;
  if (!graphDownloaded) return null;

  return (
    <div className='navigation-help'>
      <h3>Spaceship operating manual</h3>
      <table><tbody>
        <tr>
          <td colSpan="2"><code className='important-key'>mouse wheel</code></td>
          <td colSpan="2">show this help</td>
        </tr>
        <tr className='spacer-row'>
          <td colSpan='2'><code className='important-key'>any key</code></td>
          <td colSpan='2'>hide this help</td>
        </tr>
        <tr>
          <td><code>W</code></td><td>Move forward</td>
          <td><code>Up</code></td><td>Rotate up</td>
        </tr>
        <tr>
          <td><code>S</code></td><td>Move backward</td>
          <td><code>Down</code></td><td>Rotate down</td>
        </tr>
        <tr>
          <td><code>A</code></td><td>Move left</td>
          <td><code>Left</code></td><td>Rotate left</td>
        </tr>
        <tr>
          <td><code>D</code></td><td>Move right</td>
          <td><code>Right</code></td><td>Rotate right</td>
        </tr>
        <tr>
          <td><code>Q</code></td><td>Roll right</td>
          <td><code>R</code></td><td>Fly up</td>
        </tr>
        <tr>
          <td><code>E</code></td><td>Roll left</td>
          <td><code>F</code></td><td>Fly down</td>
        </tr>
        <tr>
          <td><code>shift</code></td><td>Move faster</td>
          <td><code>spacebar</code></td><td>Toggle Steering</td>
          <td><code></code></td><td></td>
        </tr>
      </tbody></table>
    </div>
  );
}
