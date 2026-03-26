import { useState, useEffect, useRef } from 'react';
import appEvents from './service/appEvents.js';
import config from '../config.js';

function renderInline(text) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, t, url) {
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
  });
}

function markdownToHtml(md) {
  var lines = md.split('\n');
  var html = '';
  var inList = false;
  lines.forEach(function(line) {
    line = line.trim();
    if (!line) {
      if (inList) { html += '</ul>'; inList = false; }
      return;
    }
    var isBullet = /^[*-] /.test(line);
    if (isBullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + renderInline(line.slice(2)) + '</li>';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<p>' + renderInline(line) + '</p>';
    }
  });
  if (inList) html += '</ul>';
  return html;
}

export default function About() {
  var [open, setOpen] = useState(false);
  var [graphName, setGraphName] = useState(null);
  var [infoHtml, setInfoHtml] = useState('');
  var [logoError, setLogoError] = useState(false);
  var panelRef = useRef(null);
  var btnRef = useRef(null);

  useEffect(function() {
    function onDownloadRequested(name) {
      setGraphName(name);
      setLogoError(false);
      setInfoHtml('');
      fetch(config.dataUrl + name + '/infos.md')
        .then(function(res) { return res.ok ? res.text() : ''; })
        .then(function(md) { if (md) setInfoHtml(markdownToHtml(md)); })
        .catch(function() {});
    }
    appEvents.downloadGraphRequested.on(onDownloadRequested);
    return function() { appEvents.downloadGraphRequested.off(onDownloadRequested); };
  }, []);

  // Close on click outside
  useEffect(function() {
    if (!open) return;
    function onMouseDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target) &&
          btnRef.current && !btnRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return function() { document.removeEventListener('mousedown', onMouseDown); };
  }, [open]);

  var logoUrl = graphName ? config.dataUrl + graphName + '/logo.png' : null;

  return (
    <>
      <div
        ref={btnRef}
        className='info-btn'
        title='About'
        onClick={function() { setOpen(function(v) { return !v; }); }}
      >
        ⓘ
      </div>
      {open && (
        <div ref={panelRef} className='info-panel'>
          <a href='#/' className='info-back-link'>← Back to Menu</a>
          {logoUrl && !logoError && (
            <div className='info-logo-wrap'>
              <img
                src={logoUrl}
                alt={graphName}
                className='info-logo'
                onError={function() { setLogoError(true); }}
              />
            </div>
          )}
          {infoHtml && (
            <div
              className='info-text'
              dangerouslySetInnerHTML={{ __html: infoHtml }}
            />
          )}
        </div>
      )}
    </>
  );
}
