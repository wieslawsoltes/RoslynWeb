using System;
using netDxf;
using netDxf.Entities;
using netDxf.Tables;
public static class NetDxfEntitiesFixture {
  public static double LineLength(double x1,double y1,double z1,double x2,double y2,double z2) {
    var entity=new Line();entity.StartPoint=new Vector3(x1,y1,z1);entity.EndPoint=new Vector3(x2,y2,z2);
    return Vector3.Distance(entity.StartPoint,entity.EndPoint);
  }
  public static double CircleArea(double radius) {
    var entity=new Circle(new Vector3(1,2,3),1);entity.Radius=radius;return Math.PI*entity.Radius*entity.Radius;
  }
  public static double ArcSweep(double start,double end) {
    var entity=new Arc(new Vector3(1,2,3),5,start,end);return MathHelper.NormalizeAngle(entity.EndAngle-entity.StartAngle);
  }
  public static int TrueColorArgb(int red,int green,int blue) {return new AciColor((byte)red,(byte)green,(byte)blue).ToColor().ToArgb();}
  public static int IndexColorArgb(int index) {return new AciColor((short)index).ToColor().ToArgb();}
  public static double PolylineMutation() {
    var entity=new Polyline2D(new[]{new Polyline2DVertex(0,0),new Polyline2DVertex(10,0),new Polyline2DVertex(10,10)},true);
    entity.Vertexes.Add(new Polyline2DVertex(0,10));entity.Vertexes.RemoveAt(1);entity.Vertexes[1].Position=new Vector2(12,9);
    entity.Vertexes[0].Bulge=0.5;entity.Vertexes[0].StartWidth=2;entity.Vertexes[2].EndWidth=2;entity.IsClosed=false;
    return entity.Vertexes.Count*100+entity.Vertexes[1].Position.X+entity.Vertexes[0].StartWidth+entity.Vertexes[2].EndWidth+(entity.IsClosed?1000:0)+entity.Vertexes[0].Bulge;
  }
  static int layerChanges;
  static void CountLayerChange(EntityObject sender,TableObjectChangedEventArgs<Layer> args) {layerChanges+=args.NewValue.Name.Length;}
  static void RedirectLayerChange(EntityObject sender,TableObjectChangedEventArgs<Layer> args) {args.NewValue=new Layer("redirected");}
  public static int LayerEvents() {
    layerChanges=0;var entity=new Line();entity.LayerChanged+=CountLayerChange;entity.LayerChanged+=CountLayerChange;
    entity.Layer=new Layer("cut");entity.LayerChanged-=CountLayerChange;entity.Layer=new Layer("etch");
    entity.LayerChanged+=RedirectLayerChange;entity.Layer=new Layer("last");entity.LayerChanged-=CountLayerChange;entity.LayerChanged-=RedirectLayerChange;
    int length=entity.Layer.Name.Length;entity.Layer=new Layer("final");return layerChanges*100+length*10+entity.Layer.Name.Length;
  }
  public static int LayerAssignment() {var entity=new Line();entity.Layer=new Layer("test");entity.Layer.Name="renamed";return entity.Layer.Name.Length;}
  public static double CircleClone() {
    var original=new Circle(new Vector3(1,2,3),4);original.Layer=new Layer("copy");var copy=(Circle)original.Clone();
    copy.Radius=7;copy.Layer.Name="changed";return original.Radius*100+copy.Radius*10+original.Layer.Name.Length+(object.ReferenceEquals(original.Layer,copy.Layer)?1000:0);
  }
  public static double InvalidCircleConstructor(double radius) {return new Circle(new Vector3(0,0,0),radius).Radius;}
  public static double InvalidCircleSetter(double radius) {var entity=new Circle();entity.Radius=radius;return entity.Radius;}
  public static int InvalidLayerName(string name) {return new Layer(name).Name.Length;}
  public static int InvalidLayerAssignment() {var entity=new Line();entity.Layer=null;return 1;}
  public static int InvalidLinetypeScale() {var entity=new Line();entity.LinetypeScale=0;return 1;}
  public static double InvalidVertexWidth(double width) {var vertex=new Polyline2DVertex();vertex.StartWidth=width;return vertex.StartWidth;}
}
