import * as THREE from "three";
import { FirstPersonControls } from "./FirstPersonControls.js";
import { MeshLoader } from "./MeshLoader.js";
import { HighResStreamer } from "./HighResStreamer.js";

// Configuration toggle
const ENABLE_SURFACE_SELECTION = true; // Set to true to enable surface selection

// The high-res model is 130 tiles, each with its own ~2048x2048 texture. Decoded
// to GPU memory that is ~2.5 GB of VRAM all at once - far beyond what any tablet
// or most laptops can hold, so uploading them all loses the WebGL context (black
// tiles / blank screen / reload loop).
//
// Instead of a wholesale swap we stream textures by proximity (LOD): the low-res
// preview stays as the always-resident base, and only the nearest tiles are
// promoted to a high-res texture, capped so resident high-res VRAM stays bounded.
// Promoted tiles are downscaled to MAX_TEXTURE_SIZE; far tiles have their high-res
// texture disposed (VRAM freed, source image kept for cheap re-upload).
const MAX_TEXTURE_SIZE = 1024; // per-tile high-res cap (1024^2 RGBA ~= 5.6 MB VRAM)
const MAX_HIGH_RES_TILES = 16; // nearest N tiles that may hold a high-res texture
const LOD_UPDATE_INTERVAL = 12; // frames between LOD re-evaluations

// Bump on every meaningful change. Shown in the info panel and logged at startup
// so it's possible to confirm the live preview is actually running current code
// (vs a stale cached bundle).
const BUILD_VERSION = "lod-stream-2";

class MeshExplorer {
  constructor() {
    console.log(`[drone-mesh] build ${BUILD_VERSION}`);
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.meshLoader = null;
    this.currentMesh = null;
    this.lowResMesh = null;
    this.isLoadingHighRes = false;
    this.currentFiles = null;

    // High-res texture streaming (see HighResStreamer).
    this.streamer = null;
    this.frameCount = 0;

    // Surface selection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.selectedSurface = null;
    this.highlightMesh = null;

    this.init();
    this.setupEventListeners();
    this.animate();

    // Auto-load the coconut farm mesh
    this.loadProgressiveMesh(
      "https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNx0lqYJJ2zb6Xow4apUyGg09cPEkSDjMLBJKHq",
      "https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNxioLwD1Ldeg4T8dxVEobRa6BzCGisrcLNPtOl"
    );
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 10, 1000);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      2000
    );
    this.camera.position.set(0, 5, 10);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Cap pixel ratio so high-DPI mobile screens don't allocate huge
    // framebuffers (a common cause of WebGL context loss on phones).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const container = document.getElementById("canvas-container");
    container.appendChild(this.renderer.domElement);

    // Handle WebGL context loss gracefully instead of leaving a blank screen.
    this.contextLost = false;
    const canvas = this.renderer.domElement;
    canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        // preventDefault lets the browser attempt to restore the context.
        event.preventDefault();
        this.contextLost = true;
        console.error("WebGL context lost");
      },
      false
    );
    canvas.addEventListener(
      "webglcontextrestored",
      () => {
        this.contextLost = false;
        console.warn("WebGL context restored");
      },
      false
    );

    this.controls = new FirstPersonControls(
      this.camera,
      this.renderer.domElement
    );

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(50, 100, 50);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -100;
    directionalLight.shadow.camera.right = 100;
    directionalLight.shadow.camera.top = 100;
    directionalLight.shadow.camera.bottom = -100;
    directionalLight.shadow.camera.near = 0.1;
    directionalLight.shadow.camera.far = 200;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    this.scene.add(directionalLight);

    const gridHelper = new THREE.GridHelper(200, 50, 0x444444, 0x888888);
    this.scene.add(gridHelper);

    // Create thick custom axes with cylinders
    const axesGroup = new THREE.Group();

    // X-axis (red)
    const xGeometry = new THREE.CylinderGeometry(0.1, 0.1, 5, 8);
    const xMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const xAxis = new THREE.Mesh(xGeometry, xMaterial);
    xAxis.rotation.z = -Math.PI / 2;
    xAxis.position.x = 2.5;
    axesGroup.add(xAxis);

    // Y-axis (green)
    const yGeometry = new THREE.CylinderGeometry(0.1, 0.1, 5, 8);
    const yMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const yAxis = new THREE.Mesh(yGeometry, yMaterial);
    yAxis.position.y = 2.5;
    axesGroup.add(yAxis);

    // Z-axis (blue)
    const zGeometry = new THREE.CylinderGeometry(0.1, 0.1, 5, 8);
    const zMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const zAxis = new THREE.Mesh(zGeometry, zMaterial);
    zAxis.rotation.x = Math.PI / 2;
    zAxis.position.z = 2.5;
    axesGroup.add(zAxis);

    // this.scene.add(axesGroup); // Hidden for now

    this.meshLoader = new MeshLoader(this.scene);
  }

  setupEventListeners() {
    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.updateControlsInfo();
    this.setupSurfaceSelection();
  }

  setupSurfaceSelection() {
    // Skip if surface selection is disabled
    if (!ENABLE_SURFACE_SELECTION) return;

    const canvas = this.renderer.domElement;

    // Handle mouse clicks for desktop
    canvas.addEventListener("click", (event) => {
      if (!this.controls.isMouseDown) {
        // Only select if not dragging
        this.handleSurfaceSelection(event.clientX, event.clientY);
      }
    });

    // Handle touch taps for mobile
    let tapTimeout = null;
    canvas.addEventListener("touchend", (event) => {
      if (event.touches.length === 0 && event.changedTouches.length === 1) {
        const touch = event.changedTouches[0];
        // Use timeout to distinguish tap from drag
        if (tapTimeout) clearTimeout(tapTimeout);
        tapTimeout = setTimeout(() => {
          this.handleSurfaceSelection(touch.clientX, touch.clientY);
        }, 100);
      }
    });

    canvas.addEventListener("touchmove", () => {
      if (tapTimeout) {
        clearTimeout(tapTimeout);
        tapTimeout = null;
      }
    });
  }

  handleSurfaceSelection(clientX, clientY) {
    if (!this.currentMesh) return;

    // Convert screen coordinates to normalized device coordinates
    this.mouse.x = (clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    // Set up raycaster
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Find intersections
    const intersects = this.raycaster.intersectObject(this.currentMesh, true);

    if (intersects.length > 0) {
      const intersection = intersects[0];
      this.selectSurface(intersection);
    }
  }

  selectSurface(intersection) {
    // Clear previous selection
    if (this.selectedSurface) {
      this.clearSurfaceSelection();
    }

    const mesh = intersection.object;
    const face = intersection.face;

    console.log("Selecting surface:", { mesh, face, intersection });

    // Set selected surface first
    this.selectedSurface = { mesh, face, intersection };

    // Then highlight the surface
    this.highlightSurface(mesh, face);

    // Classify surface type
    const surfaceType = this.classifySurface(face, intersection);
    console.log("Selected surface type:", surfaceType);
  }

  highlightSurface(mesh, face) {
    console.log("Highlighting surface with face:", face);
    console.log("Intersection data:", this.selectedSurface.intersection);

    const intersection = this.selectedSurface.intersection;

    // Transform face normal to world space for classification
    const faceWorldNormal = intersection.face.normal.clone();
    faceWorldNormal.transformDirection(mesh.matrixWorld);
    
    // Find all connected faces that form the same surface
    const connectedFaces = this.findConnectedSurface(
      mesh,
      intersection.faceIndex,
      faceWorldNormal
    );
    console.log("Found", connectedFaces.length, "connected faces");

    // Create geometry from all connected faces
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const positionAttribute = mesh.geometry.getAttribute("position");

    connectedFaces.forEach((faceIndex) => {
      if (mesh.geometry.index) {
        // Indexed geometry
        const indices = mesh.geometry.index.array;

        for (let i = 0; i < 3; i++) {
          const vertexIndex = indices[faceIndex * 3 + i];

          // Get vertex position in world space
          const vertex = new THREE.Vector3();
          vertex.fromBufferAttribute(positionAttribute, vertexIndex);
          vertex.applyMatrix4(mesh.matrixWorld);

          positions.push(vertex.x, vertex.y, vertex.z);
        }
      } else {
        // Non-indexed geometry
        for (let i = 0; i < 3; i++) {
          const vertexIndex = faceIndex * 3 + i;

          // Get vertex position in world space
          const vertex = new THREE.Vector3();
          vertex.fromBufferAttribute(positionAttribute, vertexIndex);
          vertex.applyMatrix4(mesh.matrixWorld);

          positions.push(vertex.x, vertex.y, vertex.z);
        }
      }
    });

    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3)
    );

    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6b35,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    });

    this.highlightMesh = new THREE.Mesh(geometry, highlightMaterial);

    // Offset the entire highlight slightly along face normal to avoid z-fighting
    faceWorldNormal.normalize();
    const offset = faceWorldNormal.multiplyScalar(0.01);

    // Apply offset to each vertex
    const offsetPositions = [];
    for (let i = 0; i < positions.length; i += 3) {
      offsetPositions.push(
        positions[i] + offset.x,
        positions[i + 1] + offset.y,
        positions[i + 2] + offset.z
      );
    }

    this.highlightMesh.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(offsetPositions, 3)
    );

    this.scene.add(this.highlightMesh);
    console.log("Added surface highlight with", connectedFaces.length, "faces");
  }

  findConnectedSurface(
    mesh,
    startFaceIndex,
    targetNormal,
    normalTolerance = 0.1,
    maxFaces = 200
  ) {
    const connectedFaces = new Set();
    const toProcess = [startFaceIndex];
    const positionAttribute = mesh.geometry.getAttribute("position");
    const normalAttribute = mesh.geometry.getAttribute("normal");
    
    // Get the classification of the starting face
    const startClassification = this.classifySurfaceFromNormal(targetNormal);
    console.log("Starting surface type:", startClassification);

    while (toProcess.length > 0 && connectedFaces.size < maxFaces) {
      const faceIndex = toProcess.pop();

      if (connectedFaces.has(faceIndex)) continue;

      // Get face normal
      let faceNormal;
      if (normalAttribute) {
        // Average the vertex normals
        faceNormal = new THREE.Vector3();
        for (let i = 0; i < 3; i++) {
          const vertexIndex = mesh.geometry.index
            ? mesh.geometry.index.array[faceIndex * 3 + i]
            : faceIndex * 3 + i;

          const normal = new THREE.Vector3();
          normal.fromBufferAttribute(normalAttribute, vertexIndex);
          faceNormal.add(normal);
        }
        faceNormal.normalize();
      } else {
        // Calculate face normal from vertices
        const vertices = [];
        for (let i = 0; i < 3; i++) {
          const vertexIndex = mesh.geometry.index
            ? mesh.geometry.index.array[faceIndex * 3 + i]
            : faceIndex * 3 + i;

          const vertex = new THREE.Vector3();
          vertex.fromBufferAttribute(positionAttribute, vertexIndex);
          vertices.push(vertex);
        }

        const edge1 = vertices[1].clone().sub(vertices[0]);
        const edge2 = vertices[2].clone().sub(vertices[0]);
        faceNormal = edge1.cross(edge2).normalize();
      }
      
      // Transform to world space for classification
      const worldNormal = faceNormal.clone();
      worldNormal.transformDirection(mesh.matrixWorld);

      // Check if this face has the same classification
      const faceClassification = this.classifySurfaceFromNormal(worldNormal);
      
      // Only add if same classification type (walls with walls, roofs with roofs, etc)
      if (faceClassification === startClassification) {
        connectedFaces.add(faceIndex);

        // Add adjacent faces to process (simplified - just add nearby face indices)
        for (let i = -5; i <= 5; i++) {  // Increased range for better connectivity
          const adjacentFace = faceIndex + i;
          if (
            adjacentFace >= 0 &&
            adjacentFace <
              (mesh.geometry.index
                ? mesh.geometry.index.array.length / 3
                : positionAttribute.count / 3) &&
            !connectedFaces.has(adjacentFace)
          ) {
            toProcess.push(adjacentFace);
          }
        }
      }
    }

    return Array.from(connectedFaces);
  }
  
  classifySurfaceFromNormal(worldNormal) {
    // Classify based on world-space normal vector
    const upDot = worldNormal.dot(new THREE.Vector3(0, 1, 0));
    const angle = Math.acos(Math.abs(upDot)) * (180 / Math.PI);

    if (angle < 20) {
      return upDot > 0 ? "roof-flat" : "floor";
    } else if (angle > 70) {
      return "wall";
    } else {
      return upDot > 0 ? "roof-pitched" : "slope";
    }
  }

  clearSurfaceSelection() {
    if (this.highlightMesh) {
      this.scene.remove(this.highlightMesh);
      this.highlightMesh.geometry.dispose();
      this.highlightMesh.material.dispose();
      this.highlightMesh = null;
    }
    this.selectedSurface = null;
  }

  classifySurface(face, intersection) {
    // Get face normal in world coordinates
    const normal = face.normal.clone();
    normal.transformDirection(intersection.object.matrixWorld);

    // Classify based on normal vector
    const upDot = normal.dot(new THREE.Vector3(0, 1, 0));
    const angle = Math.acos(Math.abs(upDot)) * (180 / Math.PI);

    if (angle < 20) {
      return upDot > 0 ? "roof-flat" : "floor";
    } else if (angle > 70) {
      return "wall";
    } else {
      return upDot > 0 ? "roof-pitched" : "slope";
    }
  }

  updateControlsInfo() {
    const infoDiv = document.getElementById("info");
    const isTouchDevice =
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      navigator.msMaxTouchPoints > 0;

    if (isTouchDevice) {
      infoDiv.innerHTML = `
        <strong>Touch Controls:</strong><br>
        1 finger - Look around<br>
        2 finger pinch - Move forward/back<br>
        3 finger drag - Pan left/right/up/down
      `;
    } else {
      infoDiv.innerHTML = `
        <strong>Desktop Controls:</strong><br>
        WASD - Move<br>
        Shift - Fast mode<br>
        Click + Drag - Look around
      `;
    }
    infoDiv.innerHTML += `<br><span style="opacity:0.6;font-size:11px">build ${BUILD_VERSION}</span>`;
  }

  showLoading(text = "Loading mesh...") {
    const overlay = document.getElementById("loading-overlay");
    const loadingText = document.getElementById("loading-text");
    const progressText = document.getElementById("loading-progress");

    overlay.classList.add("active");
    loadingText.textContent = text;
    progressText.textContent = "";
  }

  hideLoading() {
    const overlay = document.getElementById("loading-overlay");
    overlay.classList.remove("active");
  }

  updateLoadingProgress(progress) {
    const progressText = document.getElementById("loading-progress");
    if (progress && progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      progressText.textContent = `${percent}%`;
    }
  }

  // Free GPU resources (geometries, materials, textures) held by an object
  // tree. Three.js does NOT do this when you remove an object from the scene,
  // so without it every mesh swap leaks GPU memory until the WebGL context is
  // lost (blank screen / mobile tab reload).
  disposeObject(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (!child.isMesh) return;
      if (child.geometry) child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((material) => {
        if (!material) return;
        for (const key in material) {
          const value = material[key];
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      });
    });
  }

  async loadMeshFiles(files) {
    const startTime = performance.now();
    let lastTime = startTime;

    const logTiming = (label) => {
      const now = performance.now();
      const delta = now - lastTime;
      const total = now - startTime;
      console.log(
        `[TIMING] ${label}: ${delta.toFixed(0)}ms (total: ${total.toFixed(
          0
        )}ms)`
      );
      lastTime = now;
    };

    try {
      this.showLoading("Loading mesh file...");

      if (this.currentMesh) {
        this.scene.remove(this.currentMesh);
        this.disposeObject(this.currentMesh);
        this.currentMesh = null;
      }
      logTiming("Scene cleanup");

      // Check if it's a single GLB/GLTF file
      const filesArray = Array.from(files);
      console.log(
        "Loading files:",
        filesArray.map((f) => f.name)
      );

      const glbFile = filesArray.find(
        (f) => f.name.endsWith(".glb") || f.name.endsWith(".gltf")
      );

      // Use setTimeout to allow UI to update before heavy processing
      await new Promise((resolve) => setTimeout(resolve, 10));
      logTiming("UI update delay");

      if (glbFile) {
        console.log("Loading GLB file:", glbFile.name);
        this.currentMesh = await this.meshLoader.loadFile(
          glbFile,
          (progress) => {
            this.updateLoadingProgress(progress);
          }
        );
      } else {
        // Handle multiple files (OBJ + MTL + textures)
        console.log("Loading multiple files");
        this.currentMesh = await this.meshLoader.loadFiles(filesArray);
      }
      logTiming("File loaded and parsed");

      console.log("Mesh loaded successfully:", this.currentMesh);

      this.showLoading("Processing geometry...");

      // Calculate bounds BEFORE adding to scene
      const box = new THREE.Box3().setFromObject(this.currentMesh);
      logTiming("Bounding box calculation");

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      console.log("Mesh size:", size);

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 50 / maxDim;
      this.currentMesh.scale.multiplyScalar(scale);

      this.currentMesh.position.sub(center.multiplyScalar(scale));
      this.currentMesh.position.y = 0;
      logTiming("Scaling and positioning");

      // Optimize materials for large meshes
      let meshCount = 0;
      let materialCount = 0;
      this.currentMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          meshCount++;
          // Enable frustum culling
          child.frustumCulled = true;

          // Optimize material settings
          if (child.material) {
            materialCount++;
            child.material.precision = "mediump";
          }
        }
      });
      console.log(
        `Processed ${meshCount} meshes with ${materialCount} materials`
      );
      logTiming("Material optimization");

      this.camera.position.set(0, size.y * scale * 0.5, size.z * scale * 1.5);
      this.controls.reset();
      logTiming("Camera setup");

      // Now add to scene after all processing is done
      this.showLoading("Adding to scene...");
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.scene.add(this.currentMesh);
      logTiming("Added to scene");

      // Force a render to upload to GPU
      this.showLoading("Uploading to GPU...");
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.renderer.render(this.scene, this.camera);
      logTiming("First render (GPU upload)");

      this.hideLoading();
      logTiming("Complete");
    } catch (error) {
      this.hideLoading();
      console.error("Detailed error loading mesh:", error);
      console.error("Error stack:", error.stack);
      alert(`Failed to load mesh file: ${error.message}`);
    }
  }

  showProgressiveLoader() {
    const loader = document.getElementById("progressive-loader");
    loader.classList.add("active");
  }

  hideProgressiveLoader() {
    const loader = document.getElementById("progressive-loader");
    loader.classList.remove("active");
  }

  async loadProgressiveMesh(lowResUrl, highResUrl) {
    try {
      // Load low-res version first
      this.showLoading("Loading preview...");
      console.log("Loading low-res mesh...");

      this.lowResMesh = await this.meshLoader.loadFromUrl(
        lowResUrl,
        (progress) => {
          this.updateLoadingProgress(progress);
        }
      );

      await this.setupMesh(this.lowResMesh);
      this.hideLoading();
      console.log("Low-res mesh loaded and displayed");

      // Stream high-res textures by proximity. The 61 MB high-res GLB is fetched
      // once and stripped of its textures so nothing is decoded up front; only
      // the nearest tiles ever decode/upload a texture. This is what keeps memory
      // bounded on tablets/phones (see HighResStreamer).
      this.showProgressiveLoader();
      this.isLoadingHighRes = true;

      console.log("Starting high-res streaming...");
      this.streamer = new HighResStreamer({
        scene: this.scene,
        camera: this.camera,
        gltfLoader: this.meshLoader.loaders.gltf,
        maxTextureSize: MAX_TEXTURE_SIZE,
        maxHighResTiles: MAX_HIGH_RES_TILES,
      });
      const tileCount = await this.streamer.load(highResUrl, this.currentMesh);
      console.log(`High-res streaming active: ${tileCount} tiles`);

      this.hideProgressiveLoader();
      this.isLoadingHighRes = false;
    } catch (error) {
      this.hideLoading();
      this.hideProgressiveLoader();
      console.error("Error loading progressive mesh:", error);
      alert(`Failed to load mesh: ${error.message}`);
    }
  }

  async setupMesh(mesh) {
    const startTime = performance.now();
    let lastTime = startTime;

    const logTiming = (label) => {
      const now = performance.now();
      const delta = now - lastTime;
      const total = now - startTime;
      console.log(
        `[TIMING] ${label}: ${delta.toFixed(0)}ms (total: ${total.toFixed(
          0
        )}ms)`
      );
      lastTime = now;
    };

    if (this.currentMesh && this.currentMesh !== mesh) {
      this.scene.remove(this.currentMesh);
      this.disposeObject(this.currentMesh);
    }

    // Calculate bounds BEFORE adding to scene
    const box = new THREE.Box3().setFromObject(mesh);
    logTiming("Bounding box calculation");

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    console.log("Mesh size:", size);

    // Fix mesh orientation - rotate in world coordinates
    mesh.rotation.order = "YXZ"; // Apply Y rotation first, then X
    mesh.rotation.y = Math.PI; // 180 degrees around world Y-axis first
    mesh.rotation.x = -Math.PI / 2; // Then 90 degrees around X-axis
    logTiming("Mesh rotation fix");

    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 50 / maxDim;
    mesh.scale.multiplyScalar(scale);

    mesh.position.sub(center.multiplyScalar(scale));
    mesh.position.y = 0;
    logTiming("Scaling and positioning");

    // Optimize materials for large meshes
    let meshCount = 0;
    let materialCount = 0;
    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshCount++;
        child.frustumCulled = true;
        child.castShadow = false;
        child.receiveShadow = false;

        if (child.material) {
          materialCount++;
          child.material.precision = "mediump";
        }
      }
    });
    console.log(
      `Processed ${meshCount} meshes with ${materialCount} materials`
    );
    logTiming("Material optimization");

    // Set camera position only for first mesh - up and back from origin
    if (!this.currentMesh) {
      this.camera.position.set(0, 10, 15); // Up and back from origin
      this.controls.reset();
      this.controls.lat = -15; // Look down slightly
      this.controls.lon = -90; // Rotate to look along Z-axis
    }
    logTiming("Camera setup");

    // Add to scene
    this.scene.add(mesh);
    this.currentMesh = mesh;
    logTiming("Added to scene");

    // Force render
    this.renderer.render(this.scene, this.camera);
    logTiming("First render (GPU upload)");

    return mesh;
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    this.controls.update();

    // Don't try to render on a lost context - it just spams GL errors until
    // (and if) the browser restores it.
    if (this.contextLost) return;

    // Re-evaluate which tiles stream a high-res texture periodically (not every
    // frame - it sorts all tiles) so detail follows the camera within budget.
    this.frameCount++;
    if (this.streamer && this.frameCount % LOD_UPDATE_INTERVAL === 0) {
      this.streamer.update();
    }

    this.renderer.render(this.scene, this.camera);
  }
}

new MeshExplorer();
