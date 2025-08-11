import * as THREE from 'three';

export class FirstPersonControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    
    this.movementSpeed = 10;
    this.lookSpeed = 0.002;
    
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    
    this.lat = 0;
    this.lon = 0;
    
    this.mouseX = 0;
    this.mouseY = 0;
    this.isMouseDown = false;
    
    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    
    this.prevTime = performance.now();
    
    this.init();
  }
  
  init() {
    this.isMouseDown = true; // Always active
    
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener('keyup', (e) => this.onKeyUp(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
  }
  
  onKeyDown(event) {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.moveForward = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.moveBackward = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.moveLeft = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.moveRight = true;
        break;
    }
  }
  
  onKeyUp(event) {
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.moveForward = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.moveBackward = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.moveLeft = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.moveRight = false;
        break;
    }
  }
  
  onMouseMove(event) {
    const deltaX = event.clientX - this.mouseX;
    const deltaY = event.clientY - this.mouseY;
    
    this.lon += deltaX * this.lookSpeed * 50; // Fixed: changed from -= to +=
    this.lat -= deltaY * this.lookSpeed * 50;
    
    this.lat = Math.max(-85, Math.min(85, this.lat));
    
    this.mouseX = event.clientX;
    this.mouseY = event.clientY;
  }
  
  onMouseDown(event) {
    if (event.button === 0) {
      this.isMouseDown = true;
      this.mouseX = event.clientX;
      this.mouseY = event.clientY;
    }
  }
  
  onMouseUp(event) {
    if (event.button === 0) {
      this.isMouseDown = false;
    }
  }
  
  update() {
    const time = performance.now();
    const delta = (time - this.prevTime) / 1000;
    
    this.velocity.x -= this.velocity.x * 10.0 * delta;
    this.velocity.z -= this.velocity.z * 10.0 * delta;
    this.velocity.y -= this.velocity.y * 10.0 * delta;
    
    this.direction.z = Number(this.moveForward) - Number(this.moveBackward);
    this.direction.x = Number(this.moveRight) - Number(this.moveLeft); // Fixed: swapped left and right
    this.direction.normalize();
    
    if (this.moveForward || this.moveBackward) {
      this.velocity.z -= this.direction.z * this.movementSpeed * delta;
    }
    if (this.moveLeft || this.moveRight) {
      this.velocity.x -= this.direction.x * this.movementSpeed * delta;
    }
    
    const phi = THREE.MathUtils.degToRad(90 - this.lat);
    const theta = THREE.MathUtils.degToRad(this.lon);
    
    const lookAt = new THREE.Vector3();
    lookAt.x = this.camera.position.x + Math.sin(phi) * Math.cos(theta);
    lookAt.y = this.camera.position.y + Math.cos(phi);
    lookAt.z = this.camera.position.z + Math.sin(phi) * Math.sin(theta);
    
    this.camera.lookAt(lookAt);
    
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    
    const right = new THREE.Vector3();
    right.crossVectors(forward, this.camera.up);
    right.normalize();
    
    this.camera.position.addScaledVector(forward, -this.velocity.z);
    this.camera.position.addScaledVector(right, -this.velocity.x);
    
    this.prevTime = time;
  }
  
  reset() {
    this.lat = 0;
    this.lon = 0;
    this.velocity.set(0, 0, 0);
  }
}