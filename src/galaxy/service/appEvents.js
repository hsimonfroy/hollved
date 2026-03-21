/**
 * Defines list of global events transmitted inside the application.
 *
 * Views should never listen to these, instead stores and native renderer
 * consume these, transform them to view-friendly format and fire store-specific
 * events.
 */
import eventify from 'ngraph.events';
import eventMirror from './eventMirror.js';

var appEvents = eventify({});

export default eventMirror([
  /**
   * Fired when positions are downloaded
   */
  'positionsDownloaded',

  /**
   * Fired when entire graph is downloaded
   */
  'graphDownloaded',

  /**
   * Fired when new galaxy page is opened and graph download is required
   */
  'downloadGraphRequested',

  /**
   * Fired when user wants to toggle between turntable and spaceship control modes.
   * Fired by F key (desktop) or the on-screen mode button.
   */
  'toggleControlMode',

  /**
   * Fired after a control mode switch with the new mode string ('spaceship' | 'turntable').
   * Consumed by the UI button to update its icon.
   */
  'controlModeChanged',

  /**
   * Fired when user wants to show or hide links
   */
  'toggleLinks',

  /**
   * fired when user requesed to show or hide help screen
   */
  'toggleHelp',

  'focusScene',
  'queryChanged',

  'accelerateNavigation',

  /**
   * Fired when tracer ranges are computed after multi-tracer positions are loaded.
   * Carries an array of { id, name, color, startNode, nodeCount }.
   */
  'tracerRangesReady',

  /**
   * Fired to toggle visibility of a single tracer.
   * Arguments: (tracerId: string, visible: boolean)
   */
  'setTracerVisibility'
], appEvents);
