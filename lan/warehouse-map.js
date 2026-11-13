/* Optional original warehouse-style overlay. It is procedural and does not copy a CS asset. */
(function () {
  'use strict';
  function install(G) {
    if (!G||!G.level||!G.physics||!G.THREE||G.__lanWarehouse) return false;
    const T=G.THREE, root=new T.Group();root.name='LAN 原创仓库地图';root.userData.lanWarehouse=true;G.scene.add(root);
    const material=G.mats?.get?.('concrete')||new T.MeshStandardMaterial({color:0x65727c,roughness:.9});
    const trim=G.mats?.get?.('anodized_black')||new T.MeshStandardMaterial({color:0x18232b,roughness:.8});
    const parts=[];
    function block(name,min,max,mat=material,physics=true,opts={}) {
      const size=[max[0]-min[0],max[1]-min[1],max[2]-min[2]],mesh=new T.Mesh(new T.BoxGeometry(...size),mat);
      mesh.name=name;mesh.position.set((min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);parts.push(mesh);
      if(physics)G.physics.addBox(min,max,{tag:'lan-warehouse',surface:'concrete',...opts});
      return mesh;
    }
    // A compact CS-style warehouse in the quay-side clearing: long sight lines,
    // two aisles, cover crates and a raised loading platform.
    block('warehouse-floor',[-10,0,-12],[16,.08,14],material,false);
    block('warehouse-back-wall',[-10,0,-12],[16,6,-11.5]);
    block('warehouse-left-wall',[-10,0,-12],[-9.5,6,14]);
    block('warehouse-right-wall',[15.5,0,-12],[16,6,14]);
    block('warehouse-door-frame-left',[-2,0,-11.5],[-1.6,4,-10.8],trim);
    block('warehouse-door-frame-right',[7,0,-11.5],[7.4,4,-10.8],trim);
    block('warehouse-door-header',[-2,3.5,-11.5],[7.4,4,-10.8],trim);
    for (const x of [-7,-3,1,5,9,13]) {
      block(`warehouse-rack-${x}`,[x,0,-6.5],[x+.7,3.2,-5.7],trim);
      block(`warehouse-crate-${x}`,[x-.8,0,-3.2],[x+1.2,1.2,-1.2],material);
      block(`warehouse-crate-high-${x}`,[x-.6,1.2,-3.0],[x+1,2.3,-1.5],material);
    }
    block('warehouse-platform',[-7,0,8],[4,1.1,11],trim);
    block('warehouse-platform-ramp',[-7,0,6],[-3,1.1,8],trim,false);
    G.__lanWarehouse={root,parts,dispose(){for(const mesh of parts){mesh.geometry.dispose();if(!G.mats?.get?.('concrete'))mesh.material.dispose();}root.removeFromParent();}};
    return true;
  }
  if (typeof window!=='undefined') window.LanWarehouse=Object.freeze({install});
  if (typeof module!=='undefined') module.exports={install};
})();
