const express=require("express");
const http=require("http");
const os=require("os");
const QRCode=require("qrcode");
const {Server}=require("socket.io");

const app=express(), server=http.createServer(app), io=new Server(server);
const PORT=3000;
app.use(express.static("public"));

function getIP(){
  const nets=os.networkInterfaces();
  for(const name of Object.keys(nets)){
    for(const n of nets[name]||[]){
      if(n.family==="IPv4" && !n.internal) return n.address;
    }
  }
  return "localhost";
}

app.get("/api/room/:room",async(req,res)=>{
  const room=req.params.room.toUpperCase();
  const url=`http://${getIP()}:${PORT}/?join=${encodeURIComponent(room)}`;
  res.json({room,url,qr:await QRCode.toDataURL(url)});
});

io.on("connection",socket=>{
  socket.on("join-room",room=>socket.join(String(room).toUpperCase()));
  socket.on("stroke",d=>socket.to(d.room).emit("stroke",d));
  socket.on("shape",d=>socket.to(d.room).emit("shape",d));
  socket.on("text",d=>socket.to(d.room).emit("text",d));
  socket.on("clear",room=>socket.to(room).emit("clear"));
  socket.on("laser",d=>socket.to(d.room).emit("laser",d));
});

server.listen(PORT,()=>console.log(`AirBoard: http://${getIP()}:${PORT}`));