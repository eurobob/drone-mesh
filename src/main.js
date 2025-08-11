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
    
    this.init();
    this.setupEventListeners();
    this.animate();
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
      const file = event.target.files[0];
      if (file) {
        this.loadMeshFile(file);
      }
    });
  }

  async loadMeshFile(file) {
    try {
      if (this.currentMesh) {
        this.scene.remove(this.currentMesh);
      }
      
      this.currentMesh = await this.meshLoader.loadFile(file);
      
      const box = new THREE.Box3().setFromObject(this.currentMesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 50 / maxDim;
      this.currentMesh.scale.multiplyScalar(scale);
      
      this.currentMesh.position.sub(center.multiplyScalar(scale));
      this.currentMesh.position.y = 0;
      
      this.camera.position.set(0, size.y * scale * 0.5, size.z * scale * 1.5);
      this.controls.reset();
      
    } catch (error) {
      console.error('Error loading mesh:', error);
      alert('Failed to load mesh file. Please try a different format.');
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

new MeshExplorer();