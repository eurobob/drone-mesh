import * as THREE from "three";

export class FirstPersonControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    // When false (review mode drives the camera via OrbitControls) all input
    // is ignored and update() is a no-op that keeps prevTime fresh.
    this.enabled = true;

    this.baseMoveSpeed = 1.5; // Slower base speed
    this.fastMoveSpeed = 10; // Fast mode speed
    this.movementSpeed = this.baseMoveSpeed;
    this.lookSpeed = 0.002;

    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.isShiftPressed = false;

    this.lat = 0;
    this.lon = 0;

    this.mouseX = 0;
    this.mouseY = 0;
    this.isMouseDown = false;

    // Touch controls
    this.touches = new Map();
    this.lastPinchDistance = 0;
    this.lastTwoFingerCenter = { x: 0, y: 0 };
    this.lastThreeFingerCenter = { x: 0, y: 0 };

    this.velocity = new THREE.Vector3();
    this.direction = new THREE.Vector3();

    this.prevTime = performance.now();

    this.init();
  }

  init() {
    this.isMouseDown = false; // Click and hold to look

    document.addEventListener("keydown", (e) => this.onKeyDown(e));
    document.addEventListener("keyup", (e) => this.onKeyUp(e));
    document.addEventListener("mousemove", (e) => this.onMouseMove(e));
    document.addEventListener("mousedown", (e) => this.onMouseDown(e));
    document.addEventListener("mouseup", (e) => this.onMouseUp(e));

    // Touch events
    this.domElement.addEventListener("touchstart", (e) => this.onTouchStart(e));
    this.domElement.addEventListener("touchmove", (e) => this.onTouchMove(e));
    this.domElement.addEventListener("touchend", (e) => this.onTouchEnd(e));
  }

  onKeyDown(event) {
    if (!this.enabled) return;
    switch (event.code) {
      case "KeyW":
      case "ArrowUp":
        this.moveForward = true;
        break;
      case "KeyS":
      case "ArrowDown":
        this.moveBackward = true;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.moveLeft = true;
        break;
      case "KeyD":
      case "ArrowRight":
        this.moveRight = true;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.isShiftPressed = true;
        this.movementSpeed = this.fastMoveSpeed;
        break;
    }
  }

  onKeyUp(event) {
    if (!this.enabled) return;
    switch (event.code) {
      case "KeyW":
      case "ArrowUp":
        this.moveForward = false;
        break;
      case "KeyS":
      case "ArrowDown":
        this.moveBackward = false;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.moveLeft = false;
        break;
      case "KeyD":
      case "ArrowRight":
        this.moveRight = false;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.isShiftPressed = false;
        this.movementSpeed = this.baseMoveSpeed;
        break;
    }
  }

  onMouseMove(event) {
    if (!this.enabled) return;
    if (this.isMouseDown) {
      const deltaX = event.clientX - this.mouseX;
      const deltaY = event.clientY - this.mouseY;

      this.lon += deltaX * this.lookSpeed * 50;
      this.lat -= deltaY * this.lookSpeed * 50;

      this.lat = Math.max(-85, Math.min(85, this.lat));

      this.mouseX = event.clientX;
      this.mouseY = event.clientY;
    }
  }

  onMouseDown(event) {
    if (!this.enabled) return;
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

  onTouchStart(event) {
    if (!this.enabled) return;
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      this.touches.set(touch.identifier, {
        x: touch.clientX,
        y: touch.clientY,
        startX: touch.clientX,
        startY: touch.clientY,
      });
    }

    if (this.touches.size === 2) {
      const touchArray = Array.from(this.touches.values());
      const dx = touchArray[0].x - touchArray[1].x;
      const dy = touchArray[0].y - touchArray[1].y;
      this.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
      
      this.lastTwoFingerCenter.x = (touchArray[0].x + touchArray[1].x) / 2;
      this.lastTwoFingerCenter.y = (touchArray[0].y + touchArray[1].y) / 2;
    } else if (this.touches.size === 3) {
      const touchArray = Array.from(this.touches.values());
      this.lastThreeFingerCenter.x = (touchArray[0].x + touchArray[1].x + touchArray[2].x) / 3;
      this.lastThreeFingerCenter.y = (touchArray[0].y + touchArray[1].y + touchArray[2].y) / 3;
    }
  }

  onTouchMove(event) {
    if (!this.enabled) return;
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      const storedTouch = this.touches.get(touch.identifier);
      if (storedTouch) {
        const deltaX = touch.clientX - storedTouch.x;
        const deltaY = touch.clientY - storedTouch.y;

        if (this.touches.size === 1) {
          // 1-finger drag = look/rotation (inverted X and Y axis)
          this.lon -= deltaX * this.lookSpeed * 100;
          this.lat += deltaY * this.lookSpeed * 100;
          this.lat = Math.max(-85, Math.min(85, this.lat));
        } else if (this.touches.size === 2) {
          const touchArray = Array.from(this.touches.values());

          // Update current touch position
          storedTouch.x = touch.clientX;
          storedTouch.y = touch.clientY;

          // Calculate current distance for pinch
          const dx = touchArray[0].x - touchArray[1].x;
          const dy = touchArray[0].y - touchArray[1].y;
          const currentDistance = Math.sqrt(dx * dx + dy * dy);

          // Pinch gesture = forward/back movement
          if (this.lastPinchDistance > 0) {
            const pinchDelta = currentDistance - this.lastPinchDistance;
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            const movementAmount = pinchDelta * 0.03;
            this.camera.position.addScaledVector(forward, movementAmount);
          }

          this.lastPinchDistance = currentDistance;
        } else if (this.touches.size === 3) {
          const touchArray = Array.from(this.touches.values());

          const currentCenter = {
            x: (touchArray[0].x + touchArray[1].x + touchArray[2].x) / 3,
            y: (touchArray[0].y + touchArray[1].y + touchArray[2].y) / 3,
          };

          // 3-finger drag = strafe/pan movement
          const centerDeltaX = currentCenter.x - this.lastThreeFingerCenter.x;
          const centerDeltaY = currentCenter.y - this.lastThreeFingerCenter.y;

          if (Math.abs(centerDeltaX) > 2 || Math.abs(centerDeltaY) > 2) {
            // Minimum threshold
            const panSensitivity = 0.005;

            const right = new THREE.Vector3();
            const forward = new THREE.Vector3();
            this.camera.getWorldDirection(forward);
            right.crossVectors(forward, this.camera.up);
            right.normalize();

            // Horizontal pan (strafe left/right)
            this.camera.position.addScaledVector(
              right,
              -centerDeltaX * panSensitivity
            );

            // Vertical pan (up/down)
            this.camera.position.y += centerDeltaY * panSensitivity;
          }

          this.lastThreeFingerCenter = currentCenter;
        }

        storedTouch.x = touch.clientX;
        storedTouch.y = touch.clientY;
      }
    }
  }

  onTouchEnd(event) {
    if (!this.enabled) return;
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      this.touches.delete(touch.identifier);
    }

    // Reset movement flags when touches end
    if (this.touches.size < 2) {
      this.moveForward = false;
      this.moveBackward = false;
      this.lastPinchDistance = 0;
    }
  }

  update() {
    if (!this.enabled) {
      // Keep the clock fresh so re-enabling doesn't integrate a huge delta.
      this.prevTime = performance.now();
      return;
    }
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

  // Adopt whatever orientation the camera currently has (another controller
  // may have moved it) so re-enabling doesn't snap the view back. Inverse of
  // the lookAt math in update().
  syncFromCamera() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const phi = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.lat = 90 - THREE.MathUtils.radToDeg(phi);
    this.lon = THREE.MathUtils.radToDeg(Math.atan2(dir.z, dir.x));
    this.velocity.set(0, 0, 0);
    this.moveForward = false;
    this.moveBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
  }
}
