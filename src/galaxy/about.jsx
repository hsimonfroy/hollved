import React from 'react';
export default require('maco').template(about, React);

function about() {
  return (
    <a
      className='info-btn'
      target='_blank'
      title='About'
      href="https://github.com/anvaka/pm/tree/master/about#software-galaxies-documentation"
    >
      ⓘ
    </a>
  );
}
