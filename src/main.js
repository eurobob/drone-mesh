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

    const axesHelper = new THREE.AxesHelper(5);
    this.scene.add(axesHelper);

    this.meshLoader = new MeshLoader(this.scene);
  }

  setupEventListeners() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', (event) => {
      const files = event.target.files;
      if (files.length > 0) {
        this.loadMeshFiles(files);
      }
    });
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
    
    // Set camera position only for first mesh
    if (!this.currentMesh) {
      this.camera.position.set(0, size.y * scale * 0.5, size.z * scale * 1.5);
      this.controls.reset();
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