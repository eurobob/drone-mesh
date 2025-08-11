import * as THREE from 'three';
import { FirstPersonControls } from './FirstPersonControls.js';
import { MeshLoader } from './MeshLoader.js';

class MeshExplorer {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.meshLoader = null;
    this.currentMesh = null;
    this.lowResMesh = null;
    this.highResMesh = null;
    this.isLoadingHighRes = false;
    this.currentFiles = null;
    
    this.init();
    this.setupEventListeners();
    this.animate();
    
    // Auto-load the coconut farm mesh
    this.loadProgressiveMesh(
      'https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNx0lqYJJ2zb6Xow4apUyGg09cPEkSDjMLBJKHq',
      'https://9cw9jnmyps.ufs.sh/f/lmDN3zvaRWNxioLwD1Ldeg4T8dxVEobRa6BzCGisrcLNPtOl'
    );
  }

  init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87CEEB);
    this.scene.fog = new THREE.Fog(0x87CEEB, 10, 1000);

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      2000
    );
    this.camera.position.set(0, 5, 10);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
    const container = document.getElementById('canvas-container');
    container.appendChild(this.renderer.domElement);

    this.controls = new FirstPersonControls(this.camera, this.renderer.domElement);

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
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    this.updateControlsInfo();
  }

  updateControlsInfo() {
    const infoDiv = document.getElementById('info');
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0;
    
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
  }

  showLoading(text = 'Loading mesh...') {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const progressText = document.getElementById('loading-progress');
    
    overlay.classList.add('active');
    loadingText.textContent = text;
    progressText.textContent = '';
  }
  
  hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('active');
  }
  
  updateLoadingProgress(progress) {
    const progressText = document.getElementById('loading-progress');
    if (progress && progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      progressText.textContent = `${percent}%`;
    }
  }

  async loadMeshFiles(files) {
    const startTime = performance.now();
    let lastTime = startTime;
    
    const logTiming = (label) => {
      const now = performance.now();
      const delta = now - lastTime;
      const total = now - startTime;
      console.log(`[TIMING] ${label}: ${delta.toFixed(0)}ms (total: ${total.toFixed(0)}ms)`);
      lastTime = now;
    };
    
    try {
      this.showLoading('Loading mesh file...');
      
      if (this.currentMesh) {
        this.scene.remove(this.currentMesh);
      }
      logTiming('Scene cleanup');
      
      // Check if it's a single GLB/GLTF file
      const filesArray = Array.from(files);
      console.log('Loading files:', filesArray.map(f => f.name));
      
      const glbFile = filesArray.find(f => f.name.endsWith('.glb') || f.name.endsWith('.gltf'));
      
      // Use setTimeout to allow UI to update before heavy processing
      await new Promise(resolve => setTimeout(resolve, 10));
      logTiming('UI update delay');
      
      if (glbFile) {
        console.log('Loading GLB file:', glbFile.name);
        this.currentMesh = await this.meshLoader.loadFile(glbFile, (progress) => {
          this.updateLoadingProgress(progress);
        });
      } else {
        // Handle multiple files (OBJ + MTL + textures)
        console.log('Loading multiple files');
        this.currentMesh = await this.meshLoader.loadFiles(filesArray);
      }
      logTiming('File loaded and parsed');
      
      console.log('Mesh loaded successfully:', this.currentMesh);
      
      this.showLoading('Processing geometry...');
      
      // Calculate bounds BEFORE adding to scene
      const box = new THREE.Box3().setFromObject(this.currentMesh);
      logTiming('Bounding box calculation');
      
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      
      console.log('Mesh size:', size);
      
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 50 / maxDim;
      this.currentMesh.scale.multiplyScalar(scale);
      
      this.currentMesh.position.sub(center.multiplyScalar(scale));
      this.currentMesh.position.y = 0;
      logTiming('Scaling and positioning');
      
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
            child.material.precision = 'mediump';
          }
        }
      });
      console.log(`Processed ${meshCount} meshes with ${materialCount} materials`);
      logTiming('Material optimization');
      
      this.camera.position.set(0, size.y * scale * 0.5, size.z * scale * 1.5);
      this.controls.reset();
      logTiming('Camera setup');
      
      // Now add to scene after all processing is done
      this.showLoading('Adding to scene...');
      await new Promise(resolve => setTimeout(resolve, 10));
      this.scene.add(this.currentMesh);
      logTiming('Added to scene');
      
      // Force a render to upload to GPU
      this.showLoading('Uploading to GPU...');
      await new Promise(resolve => setTimeout(resolve, 10));
      this.renderer.render(this.scene, this.camera);
      logTiming('First render (GPU upload)');
      
      this.hideLoading();
      logTiming('Complete');
      
    } catch (error) {
      this.hideLoading();
      console.error('Detailed error loading mesh:', error);
      console.error('Error stack:', error.stack);
      alert(`Failed to load mesh file: ${error.message}`);
    }
  }

  showProgressiveLoader() {
    const loader = document.getElementById('progressive-loader');
    loader.classList.add('active');
  }
  
  hideProgressiveLoader() {
    const loader = document.getElementById('progressive-loader');
    loader.classList.remove('active');
  }

  async loadProgressiveMesh(lowResUrl, highResUrl) {
    try {
      // Load low-res version first
      this.showLoading('Loading preview...');
      console.log('Loading low-res mesh...');
      
      this.lowResMesh = await this.meshLoader.loadFromUrl(lowResUrl, (progress) => {
        this.updateLoadingProgress(progress);
      });
      
      await this.setupMesh(this.lowResMesh);
      this.hideLoading();
      console.log('Low-res mesh loaded and displayed');
      
      // Start loading high-res in background
      this.showProgressiveLoader();
      this.isLoadingHighRes = true;
      
      console.log('Starting high-res load in background...');
      this.highResMesh = await this.meshLoader.loadFromUrl(highResUrl);
      
      // Swap to high-res
      await this.swapToHighRes();
      
    } catch (error) {
      this.hideLoading();
      this.hideProgressiveLoader();
      console.error('Error loading progressive mesh:', error);
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
      console.log(`[TIMING] ${label}: ${delta.toFixed(0)}ms (total: ${total.toFixed(0)}ms)`);
      lastTime = now;
    };
    
    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
    }
    
    // Calculate bounds BEFORE adding to scene
    const box = new THREE.Box3().setFromObject(mesh);
    logTiming('Bounding box calculation');
    
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    
    console.log('Mesh size:', size);
    
    // Fix mesh orientation - rotate in world coordinates
    mesh.rotation.order = 'YXZ'; // Apply Y rotation first, then X
    mesh.rotation.y = Math.PI; // 180 degrees around world Y-axis first
    mesh.rotation.x = -Math.PI / 2; // Then 90 degrees around X-axis
    logTiming('Mesh rotation fix');
    
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 50 / maxDim;
    mesh.scale.multiplyScalar(scale);
    
    mesh.position.sub(center.multiplyScalar(scale));
    mesh.position.y = 0;
    logTiming('Scaling and positioning');
    
    // Optimize materials for large meshes
    let meshCount = 0;
    let materialCount = 0;
    mesh.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshCount++;
        child.frustumCulled = true;
        
        if (child.material) {
          materialCount++;
          child.material.precision = 'mediump';
        }
      }
    });
    console.log(`Processed ${meshCount} meshes with ${materialCount} materials`);
    logTiming('Material optimization');
    
    // Set camera position only for first mesh - up and back from origin
    if (!this.currentMesh) {
      this.camera.position.set(0, 10, 15);  // Up and back from origin
      this.controls.reset();
      this.controls.lat = -15; // Look down slightly
      this.controls.lon = -90; // Rotate to look along Z-axis
    }
    logTiming('Camera setup');
    
    // Add to scene
    this.scene.add(mesh);
    this.currentMesh = mesh;
    logTiming('Added to scene');
    
    // Force render
    this.renderer.render(this.scene, this.camera);
    logTiming('First render (GPU upload)');
    
    return mesh;
  }
  
  async swapToHighRes() {
    console.log('Swapping to high-res mesh...');
    
    // Store camera position
    const cameraPos = this.camera.position.clone();
    const cameraTarget = this.controls.lat;
    const cameraRotation = this.controls.lon;
    
    // Setup high-res mesh
    await this.setupMesh(this.highResMesh);
    
    // Restore camera position
    this.camera.position.copy(cameraPos);
    this.controls.lat = cameraTarget;
    this.controls.lon = cameraRotation;
    
    this.hideProgressiveLoader();
    this.isLoadingHighRes = false;
    
    console.log('Successfully swapped to high-res mesh');
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

new MeshExplorer();