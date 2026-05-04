function adminAuth(req,res,next){
  const token = req.headers['x-admin-token'] || req.query.token;
  if(!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN){ return res.status(401).json({ok:false,error:'Unauthorised admin request'}); }
  next();
}
module.exports={adminAuth};
