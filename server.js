import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req,res)=>{
  res.send("Backend running");
});

// LOCAL SUCCESS PAGE
app.get("/payment-success",(req,res)=>{
  res.send(`
    <h2>Payment Successful</h2>
    <p>You can now check your email or download your PDF.</p>
  `);
});

// LOCAL CANCEL PAGE
app.get("/payment-cancelled",(req,res)=>{
  res.send(`
    <h2>Payment Cancelled</h2>
    <p>Your payment was not completed.</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Server running on "+PORT));
