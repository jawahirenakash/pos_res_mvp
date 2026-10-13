import jwt from 'jsonwebtoken';
import { prisma } from './db.js';
import { config } from './config.js';
export const JWT_ISSUER='tabletap',JWT_AUDIENCE='tabletap-pos';
export async function authenticate(req,res,next){const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):'';if(!token)return res.status(401).json({error:'Sign in required'});try{const p=jwt.verify(token,config.jwtSecret,{issuer:JWT_ISSUER,audience:JWT_AUDIENCE,algorithms:['HS256']});if(typeof p.sub!=='string')throw new Error('bad subject');const u=await prisma.user.findUnique({where:{id:p.sub}});if(!u||!u.active)return res.status(401).json({error:'Account unavailable'});req.user=u;next()}catch{return res.status(401).json({error:'Session expired or invalid'})}}
export function allowRoles(...roles){return(req,res,next)=>req.user&&roles.includes(req.user.role)?next():res.status(403).json({error:'Permission denied'})}
