# Hollved
An interactive visualizer of the largest 3D maps of the Universe.


![DESI DR1](assets/desi_dr1_round.png)


## Status
This project is currently in development. If you find it useful, consider sharing it, providing feedback, or starring ⭐ this GitHub repository.

## Features
* Visualize the evolution of the spectroscopic surveys, that are mapping the Universe since the end of the 1970s. Learn about the specificities of each survey.
* Orbit or fly-through the galaxies. Set your speed, select galaxy populations, display their volume and radial densities. Get an intuition about the cosmic scales, from the Milky-Way to the Cosmic Microwave Background (CMB) and the observable Universe.
* Look at survey footprints, the large-scale structures of the cosmic web, and redshift-space distortions like the finger of god effect.  

## Processing
* Datasets are downloaded from public databases. Some can require additional processing like quality cuts or population splits, which are detailed in their companion papers.
* Angular and redshift data are converted into 3D positions in comoving Mpc assuming [Planck2018](https://arxiv.org/pdf/1807.06209) fiducial cosmology.
* **Rendering millions of galaxies interactively requires careful performance trade-offs**, especially for mobile devices. Coordinates are stored as Float16 in binary files to minimise load times. On the rendering side, additive blending combined with generalized Reinhard luminance tone mapping eliminates the need for depth-buffer sorting, while maintaining some visual quality.
* Tracer densities are computed from Kernel Density Estimation (KDE) over comoving distances. In particular, redshift radial densities are computed by forwarding distance radial densities to avoid KDE over redshifts. Volume densities are compensated from tracer footprint to be meaningful, while radial densities are not.
* Local group galaxies are rendered by randomly sampling a faithful depiction, then randomly extruding it according to alpha channel. 

## Acknowledgements
This project has been deeply inspired by Andrei Kashcha's [software package visualizer](https://github.com/anvaka/pm), Charlie Hoey's [Gaia DR1 rendering](https://cdn.charliehoey.com/threejs-demos/gaia_dr1.html), and Claire Lamman's [DESI visuals](https://cmlamman.github.io/science_art.html).