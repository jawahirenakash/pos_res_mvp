import 'dotenv/config';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { checkPassword } from '../src/validate.js';

const db = new PrismaClient();
const ownerEmail = (process.env.SEED_OWNER_EMAIL || 'owner@tabletap.local').toLowerCase();
const provided = (process.env.SEED_OWNER_PASSWORD || '').trim();
// Never ship a hardcoded password: use the one from .env, or generate a random one and print it once.
const generated = `Tt${crypto.randomBytes(9).toString('base64url')}7`;
const password = provided || generated;
const problem = checkPassword(password);
if (problem) throw new Error(`SEED_OWNER_PASSWORD is too weak: ${problem}`);
console.log(provided ? 'Using SEED_OWNER_PASSWORD from .env.' : `Generated demo password (change on first sign-in): ${generated}`);

async function main(){
 const r=await db.restaurant.upsert({where:{id:'demo-restaurant'},update:{},create:{id:'demo-restaurant',name:process.env.BUSINESS_NAME||'TableTap Demo Restaurant',countryCode:'US',currency:'USD',timezone:'America/New_York',taxRate:0.0825}});
 const passwordHash=await bcrypt.hash(password,12);
 // mustChangePassword is set so the shared demo password cannot survive into real use.
 await db.user.upsert({where:{email:ownerEmail},update:{passwordHash,restaurantId:r.id,mustChangePassword:true,failedLoginAttempts:0,lockedUntil:null},create:{restaurantId:r.id,name:'Demo Owner',email:ownerEmail,passwordHash,role:'OWNER',mustChangePassword:true}});
 const rows=[['Mains','Classic Cheeseburger',12.5,'Beef, cheddar, house sauce'],['Mains','Margherita Pizza',14,'Tomato, mozzarella, basil'],['Mains','Grilled Chicken Bowl',13.75,'Rice, greens'],['Sides','French Fries',4.5,'Crispy cut'],['Sides','Garlic Bread',5,'Herb butter'],['Desserts','Chocolate Brownie',6,'Warm cocoa brownie'],['Drinks','Iced Latte',4.75,'Espresso and milk'],['Drinks','Fresh Lemonade',3.5,'Lemon and mint']];
 for(const [cn,name,price,description] of rows){const c=await db.category.upsert({where:{restaurantId_name:{restaurantId:r.id,name:cn}},update:{},create:{restaurantId:r.id,name:cn}});if(!await db.menuItem.findFirst({where:{restaurantId:r.id,name}}))await db.menuItem.create({data:{restaurantId:r.id,categoryId:c.id,name,price,description}})}
 for(let n=1;n<=8;n++){const label=`Table ${String(n).padStart(2,'0')}`;await db.diningTable.upsert({where:{restaurantId_label:{restaurantId:r.id,label}},update:{},create:{restaurantId:r.id,label,seats:n<=4?2:4}})}
 for(const [name,unit,quantity,lowStockAt] of [['Burger buns','pcs',30,8],['Cheddar slices','pcs',24,6],['Coffee beans','g',1500,300],['Milk','ml',8000,1500],['Potatoes','kg',12,3]])await db.ingredient.upsert({where:{restaurantId_name:{restaurantId:r.id,name}},update:{},create:{restaurantId:r.id,name,unit,quantity,lowStockAt}});
 console.log(`Seeded. Login: ${ownerEmail} / ${password}`);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
