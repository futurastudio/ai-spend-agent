import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const alt = "Tilden. Your agents are doing more. Know where the money goes.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
const palette = { blue: "#243ccb", white: "#ffffff", pale: "#d3dcff", line: "#6879dc" };

export default async function Image() {
  const [font, logo] = await Promise.all([
    readFile(join(process.cwd(), "public/fonts/geist-medium.ttf")),
    readFile(join(process.cwd(), "public/brand/lockup/tilden-lockup-horizontal-white.svg")),
  ]);
  return new ImageResponse(<div style={{ width:"100%",height:"100%",display:"flex",flexDirection:"column",padding:64,background:palette.blue,color:palette.white,fontFamily:"Geist",fontWeight:500 }}>
    <img src={`data:image/svg+xml;base64,${logo.toString("base64")}`} width={168} height={39.2} alt="" />
    <div style={{ display:"flex",flexDirection:"column",fontSize:72,lineHeight:1.05,letterSpacing:-4,marginTop:76 }}><span>Your agents are doing more.</span><span style={{ color:palette.pale }}>Know where the money goes.</span></div>
    <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:"auto",paddingTop:26,borderTop:`1px solid ${palette.line}`,fontSize:21,color:palette.pale }}><span>Explain your AI spend.</span><span>asktilden.com</span></div>
  </div>, { ...size, fonts:[{ name:"Geist",data:font,weight:500,style:"normal" }] });
}
