import { Worker, DelayedError, type Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { prisma, redis, search } from './clients.js';

type Payload={emailId:string;userId:string;sender:string;hourlyLimit?:number};
const reserveLua=`
local now=tonumber(ARGV[1]); local gap=tonumber(ARGV[2]); local cap=tonumber(ARGV[3]); local ttl=tonumber(ARGV[4]);
local reserved=tonumber(redis.call('GET',KEYS[3]) or '0'); if reserved>0 then return reserved end
local hour=math.floor(now/3600000); local window='mail:hour:'..KEYS[1]..':'..hour;
local count=tonumber(redis.call('GET',window) or '0');
if count>=cap then return (hour+1)*3600000 end
local nextAt=tonumber(redis.call('GET',KEYS[2]) or '0'); local due=math.max(now,nextAt);
redis.call('INCR',window); if count==0 then redis.call('PEXPIRE',window,ttl) end;
redis.call('SET',KEYS[2],due+gap,'PX',math.max(ttl,gap*2)); if due>now then redis.call('SET',KEYS[3],due,'PX',ttl) end; return due
`;
const transporter=nodemailer.createTransport({host:process.env.ETHEREAL_HOST??'smtp.ethereal.email',port:Number(process.env.ETHEREAL_PORT??587),secure:Number(process.env.ETHEREAL_PORT)===465,auth:{user:process.env.ETHEREAL_USER,password:process.env.ETHEREAL_PASSWORD}} as any);
async function notifySlack(userId:string,sender:string,cap:number){
  const user=await prisma.user.findUnique({where:{id:userId},select:{slackWebhookUrl:true}});if(!user?.slackWebhookUrl)return;
  const window=Math.floor(Date.now()/3600000);const key=`slack:ratelimit:${userId}:${sender}:${window}`;
  if(await redis.set(key,'1','EX',7200,'NX')!=='OK')return;
  try{const response=await fetch(user.slackWebhookUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:`Hourly email limit reached for ${sender} (${cap} emails). Remaining messages are queued for the next hour.`})});if(!response.ok){await redis.del(key);console.error('Slack notification failed',await response.text());}}
  catch(error){await redis.del(key);console.error('Slack notification failed',error);}
}
const worker=new Worker<Payload>('email-send',async(job:Job<Payload>,token?:string)=>{
  const {emailId,userId,sender}=job.data;const email=await prisma.email.findUnique({where:{id:emailId}});if(!email||email.status==='SENT')return;
  const cap=Math.max(1,job.data.hourlyLimit??config.hourlyLimit);const now=Date.now();
  const due=Number(await redis.eval(reserveLua,3,`sender:${userId}:${sender}`,`sender:next:${userId}:${sender}`,`sender:reserved:${job.id}`,now,config.delayMs,cap,7200000));
  if(due>now){if(due>=Math.floor(now/3600000+1)*3600000)await notifySlack(userId,sender,cap);await job.moveToDelayed(due,token);throw new DelayedError();}
  await redis.del(`sender:reserved:${job.id}`); await prisma.email.update({where:{id:emailId},data:{status:'PROCESSING',error:null}});
  try{
    if(!process.env.ETHEREAL_USER||!process.env.ETHEREAL_PASSWORD)throw new Error('Configure ETHEREAL_USER and ETHEREAL_PASSWORD before sending.');
    const info=await transporter.sendMail({from:sender,to:email.recipient,subject:email.subject,text:email.body});
    const sentAt=new Date();await prisma.email.update({where:{id:emailId},data:{status:'SENT',sentAt,error:null}});
    if(search)try{await search.index({index:'emails',id:email.id,document:{id:email.id,userId,recipient:email.recipient,sender,subject:email.subject,body:email.body,status:'SENT',sentAt:sentAt.toISOString()}});}catch(e){console.error('Email sent but search indexing failed',e);}
    console.log(`Sent ${emailId}; preview: ${nodemailer.getTestMessageUrl(info as any)??'(Ethereal preview unavailable)'}`);
  }catch(error){const message=error instanceof Error?error.message:'Email send failed';await prisma.email.update({where:{id:emailId},data:{status:'FAILED',error:message}});if(search)try{await search.index({index:'emails',id:email.id,document:{id:email.id,userId,recipient:email.recipient,sender,subject:email.subject,body:email.body,status:'FAILED',error:message}});}catch{}throw error;}
},{connection:redis,concurrency:config.concurrency});
worker.on('completed',job=>console.log(`Completed ${job.id}`));worker.on('failed',(job,error)=>console.error(`Job ${job?.id} failed`,error));
console.log(`Email worker ready; concurrency=${config.concurrency}, minimum send gap=${config.delayMs}ms`);
process.on('SIGINT',async()=>{await worker.close();await prisma.$disconnect();await redis.quit();process.exit(0);});
