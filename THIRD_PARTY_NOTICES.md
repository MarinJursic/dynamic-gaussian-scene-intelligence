# Third-party media

## ESO Guesthouse living room panorama

- **Asset:** `Guesthouse living room (gh-livingroom-pan)`
- **Creator:** European Southern Observatory (ESO)
- **Original:** [ESO image page](https://www.eso.org/public/images/gh-livingroom-pan/) and [Wikimedia Commons record](https://commons.wikimedia.org/wiki/File:Guesthouse_living_room_(gh-livingroom-pan).jpg)
- **License:** [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- **Local derivatives:** `public/captures/eso-guesthouse/context.jpg`, `context-8k.jpg`, `context-webgl.jpg`, the six source-view crops in `public/captures/eso-guesthouse/source-views/`, `public/room-inputs/room-00.jpg` through `room-11.jpg`, and `public/room-demo/environment.jpg`
- **Changes:** resized for web delivery and converted from the equirectangular original into rectilinear source directions. `context-8k.jpg` is an 8192×4096 Lanczos-resampled JPEG made from ESO's 15214×7607 Large JPEG; no generative content was added.

The app labels the hosted example as photographic context. It does not claim that these derivatives are a trained 3D Gaussian Splat.

## AWS Gaussian Splatting Toolbox kitchen sample

- **Asset:** `source/Gradio/favorites/kitchen_island.sog`
- **Publisher:** AWS Solutions Library Samples
- **Original:** [Guidance for Open Source 3D Reconstruction Toolbox for Gaussian Splats on AWS](https://github.com/aws-solutions-library-samples/guidance-for-open-source-3d-reconstruction-toolbox-for-gaussian-splats-on-aws)
- **License:** [MIT No Attribution (MIT-0)](https://github.com/aws-solutions-library-samples/guidance-for-open-source-3d-reconstruction-toolbox-for-gaussian-splats-on-aws/blob/main/LICENSE)
- **Local copy:** `public/splats/kitchen-island.sog`
- **Changes:** renamed for URL consistency; Gaussian data is otherwise unchanged.

AWS publishes this trained interior asset as a representative output of its full image/video → SfM → Gaussian training pipeline. The app identifies it separately from the ESO photographic context and renders it with Spark’s anisotropic Gaussian path.
