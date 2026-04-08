import { useState, useEffect } from 'react';
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
    function onKeyDown(e) {
      if (e.keyCode === 73 && !e.altKey && !e.ctrlKey && !e.metaKey) {
        setOpen(function(v) { return !v; });
      }
    }
    appEvents.downloadGraphRequested.on(onDownloadRequested);
    document.body.addEventListener('keydown', onKeyDown);
    return function() {
      appEvents.downloadGraphRequested.off(onDownloadRequested);
      document.body.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  var logoUrl = graphName ? config.dataUrl + graphName + '/logo.png' : null;

  return (
    <>
      <div
        className='info-btn'
        title='Survey info'
        onClick={function() { setOpen(function(v) { return !v; }); }}
      >
        {/* <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e399"><path d="M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/></svg> */}
        🔭
      </div>
      {open && (
        <>
          <div className='info-panel-backdrop' onClick={function() { setOpen(false); }} onContextMenu={function(e) { e.preventDefault(); setOpen(false); }} />
          <div className='info-panel'>
            <div className='info-panel-header'>Survey Info</div>
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
        </>
      )}
    </>
  );
}
