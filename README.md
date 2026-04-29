# Hollved
An interactive visualizer of the largest 3D maps of the Universe.


![DESI DR1](assets/desi_dr1_round.png)


## Status
This project is currently in development. If you find it useful, consider sharing it, providing feedback, or starring ⭐ this GitHub repository.


## Processing
* Datasets are downloaded from public databases. Some can require additional processing like quality cuts or population splits, which are detailed in their companion papers.
* Angular and redshift data are converted into 3D positions in comoving Mpc assuming [Planck2018](https://arxiv.org/pdf/1807.06209) fiducial cosmology.
* **Rendering millions of galaxies interactively requires careful performance trade-offs**, especially for mobile devices. Coordinates are stored as Float16 in binary files to minimise load times. On the rendering side, additive blending combined with generalized Reinhard luminance tone mapping eliminates the need for depth-buffer sorting, while maintaining some visual quality.
* Tracer densities are computed from Kernel Density Estimation (KDE) over comoving distances. In particular, redshift radial density is computed by forwarding distance radial density to avoid KDE over redshifts. Volume densities are compensated from tracer footprint to be meaningful, while radial densities are not.
* Local group galaxies are rendered by randomly sampling faithful depictions, then randomly extruding them according to alpha channel. 

## Acknowledgements
This project has been deeply inspired by Andrei Kashcha's [software package visualizer](https://github.com/anvaka/pm), Charlie Hoey's [Gaia DR1 rendering](https://cdn.charliehoey.com/threejs-demos/gaia_dr1.html), and Claire Lamman's [DESI visuals](https://cmlamman.github.io/science_art.html).