import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export class MeshLoader {
  constructor(scene) {
    this.scene = scene;
    this.loaders = {
      obj: new OBJLoader(),
      gltf: new GLTFLoader(),
      glb: new GLTFLoader(),
      ply: new PLYLoader(),
      stl: new STLLoader()
    };
  }

  async loadFile(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const url = URL.createObjectURL(file);

    try {
      let mesh;
      
      switch (extension) {
        case 'obj':
          mesh = await this.loadOBJ(url);
          break;
        case 'gltf':
        case 'glb':
          mesh = await this.loadGLTF(url);
          break;
        case 'ply':
          mesh = await this.loadPLY(url);
          break;
        case 'stl':
          mesh = await this.loadSTL(url);
          break;
        default:
          throw new Error(`Unsupported file format: ${extension}`);
      }

      URL.revokeObjectURL(url);
      return mesh;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  loadOBJ(url) {
    return new Promise((resolve, reject) => {
      this.loaders.obj.load(
        url,
        (object) => {
          object.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.material = new THREE.MeshPhongMaterial({
                color: 0x888888,
                side: THREE.DoubleSide
              });
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          this.scene.add(object);
          resolve(object);
        },
        (progress) => {
          console.log('Loading progress:', (progress.loaded / progress.total * 100) + '%');
        },
        (error) => reject(error)
      );
    });
  }

  loadGLTF(url) {
    return new Promise((resolve, reject) => {
      this.loaders.gltf.load(
        url,
        (gltf) => {
          const object = gltf.scene;
          object.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.castShadow = true;
              child.receiveShadow = true;
              if (!child.material) {
                child.material = new THREE.MeshPhongMaterial({
                  color: 0x888888,
                  side: THREE.DoubleSide
                });
              }
            }
          });
          this.scene.add(object);
          resolve(object);
        },
        (progress) => {
          console.log('Loading progress:', (progress.loaded / progress.total * 100) + '%');
        },
        (error) => reject(error)
      );
    });
  }

  loadPLY(url) {
    return new Promise((resolve, reject) => {
      this.loaders.ply.load(
        url,
        (geometry) => {
          geometry.computeVertexNormals();
          const material = new THREE.MeshPhongMaterial({
            color: 0x888888,
            side: THREE.DoubleSide,
            vertexColors: geometry.hasAttribute('color')
          });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          
          const object = new THREE.Group();
          object.add(mesh);
          this.scene.add(object);
          resolve(object);
        },
        (progress) => {
          console.log('Loading progress:', (progress.loaded / progress.total * 100) + '%');
        },
        (error) => reject(error)
      );
    });
  }

  loadSTL(url) {
    return new Promise((resolve, reject) => {
      this.loaders.stl.load(
        url,
        (geometry) => {
          geometry.computeVertexNormals();
          const material = new THREE.MeshPhongMaterial({
            color: 0x888888,
            side: THREE.DoubleSide
          });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          
          const object = new THREE.Group();
          object.add(mesh);
          this.scene.add(object);
          resolve(object);
        },
        (progress) => {
          console.log('Loading progress:', (progress.loaded / progress.total * 100) + '%');
        },
        (error) => reject(error)
      );
    });
  }
}